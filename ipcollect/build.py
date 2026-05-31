"""把数据库导出为纯静态、分片的 Web 看板产物 (dist/)，可直接部署到 Cloudflare Pages。

无服务器：前端只 fetch data/*.json。分片策略 (见 web/app.js 数据契约)：
  data/index.json              统计 + 城市清单(含分片数) + ASN 名称表 + path 预制下拉 + focus
  data/prefixes/<cid>-<p>.json 某城市的前缀(含每前缀的去重 AS_PATH, 供 path 搜索与 insight 抽屉)

每个前缀内嵌它的去重 AS_PATH（ingest 时已去重、直接从 pathobs 读，见 _paths_all），这样 path 顺序
搜索与 multihome 抽屉都用同一份数据、无需二次请求。大城市按 PART_SIZE 个前缀二次切分，避免单文件超
CF Pages 25MiB 上限。仅用标准库。
"""
from __future__ import annotations

import ipaddress
import json
import shutil
import time
from pathlib import Path

from . import bgp, geoip, report

WEB_DIR = Path(__file__).resolve().parent / "web"
STATIC_FILES = ("index.html", "style.css", "app.js")

PART_SIZE = 2500   # 每个城市分片最多多少个前缀（控制单文件体积）
PATH_CAP = 24      # 每前缀最多导出多少条去重 path（短路径优先）
KID_CAP = 64       # 每前缀最多内嵌多少个直接子段（更小段; 大聚合段会很多, 截断并标注）
SEG_CAP = 48       # 每个前缀在某城市内最多内嵌多少条 ipdb 子段（跨城大段会很多, 截断并标注）


def _write_json(path: Path, obj, pretty: bool) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None,
                      separators=None if pretty else (",", ":"), default=str)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _paths_all(conn) -> dict[int, list]:
    """一次扫 pathobs(已去重), 得 prefix_id -> 路径列表 [{"asns":[...],"peers":n}](短路径优先, 限 PATH_CAP)。"""
    import itertools
    cur = conn.execute(
        "SELECT prefix_id,path_clean,path_len,n_peers FROM pathobs "
        "ORDER BY prefix_id, path_len ASC, n_peers DESC")
    out: dict[int, list] = {}
    for pid, grp in itertools.groupby(cur, key=lambda r: r["prefix_id"]):
        rows = list(grp)[:PATH_CAP]
        out[pid] = [{"asns": [int(x) for x in r["path_clean"].split()] if r["path_clean"] else [],
                     "peers": r["n_peers"]} for r in rows]
    return out


def _forest(conn) -> tuple[list, dict, dict]:
    """库内 IPv4 前缀的层状(laminar)森林: 按 (start asc, end desc) 一次栈扫描得 parent/children。
    返回 (items 按上述排序, parent: pid->父item, children: pid->[直接子item])。
    供 (a) 父子段(更大/更小段) 与 (b) 有效路由切段(前缀范围扣掉更具体子段) 共用。
    """
    rows = conn.execute(
        "SELECT id,prefix,start_num,end_num,plen FROM prefix WHERE family=4").fetchall()
    items = [{"id": r["id"], "prefix": r["prefix"], "start": r["start_num"],
              "end": r["end_num"], "plen": r["plen"]} for r in rows]
    items.sort(key=lambda x: (x["start"], -x["end"]))   # 母段先于子段
    parent: dict[int, dict] = {}
    children: dict[int, list] = {}
    stack: list[dict] = []
    for it in items:
        while stack and stack[-1]["end"] < it["start"]:
            stack.pop()
        if stack:
            p = stack[-1]
            parent[it["id"]] = p
            children.setdefault(p["id"], []).append(it)
        stack.append(it)
    return items, parent, children


def _ranges_to_cidrs(intervals: list) -> list[str]:
    """把若干 [s,e] 区间合并相邻后归纳为最简 CIDR 列表(比逐段 IP 范围紧凑可读)。"""
    merged: list[list] = []
    for s, e in sorted(intervals):
        if merged and s <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    out: list[str] = []
    for s, e in merged:
        for net in ipaddress.summarize_address_range(
                ipaddress.IPv4Address(s), ipaddress.IPv4Address(e)):
            out.append(str(net))
    return out


def _subtract(s: int, e: int, holes: list) -> list[tuple]:
    """从区间 [s,e] 扣掉若干 holes [(hs,he),...] (不相交, 已在 [s,e] 内), 返回剩余区间列表。
    用于"有效路由范围"= 前缀范围 − 更具体子段(longest-prefix-match: 子段自有路由, 不归母段)。"""
    out, cur = [], s
    for hs, he in sorted(holes):
        if hs > cur:
            out.append((cur, hs - 1))
        cur = max(cur, he + 1)
        if cur > e:
            break
    if cur <= e:
        out.append((cur, e))
    return out


def _hierarchy(items, parent, children, cid_of) -> tuple[dict, dict]:
    """由森林算 sup(更大/母段链)/sub(更小/子段)。cid_of: pid->代表城市分片 id, 供跳转。"""
    lite = lambda it: {"pid": it["id"], "prefix": it["prefix"], "plen": it["plen"],
                       "cid": cid_of.get(it["id"])}
    # 子树规模(全部后代数), 按 plen 降序(叶子先)自底向上累加
    desc_n: dict[int, int] = {}
    for it in sorted(items, key=lambda x: -x["plen"]):
        desc_n[it["id"]] = sum(1 + desc_n.get(ch["id"], 0) for ch in children.get(it["id"], []))
    sup: dict[int, list] = {}
    sub: dict[int, dict] = {}
    for it in items:
        chain = []
        p = parent.get(it["id"])
        while p is not None:
            chain.append(lite(p)); p = parent.get(p["id"])
        if chain:
            sup[it["id"]] = chain
        kids = children.get(it["id"]) or []
        if kids:
            shown = [dict(lite(ch), subn=desc_n.get(ch["id"], 0))
                     for ch in sorted(kids, key=lambda x: x["start"])[:KID_CAP]]
            sub[it["id"]] = {"n": desc_n.get(it["id"], 0), "imm": len(kids), "kids": shown}
    return sup, sub


def build(cfg: dict, conn, out_dir: str = "dist", pretty: bool = False) -> dict:
    out = Path(out_dir)
    data = out / "data"
    # 清掉旧的分片(城市数/编号会变, 否则残留过期 c00xx-*.json 会膨胀产物且误导)
    if (data / "prefixes").exists():
        shutil.rmtree(data / "prefixes")
    (data / "prefixes").mkdir(parents=True, exist_ok=True)

    # 1) 拷贝静态前端
    for f in STATIC_FILES:
        shutil.copyfile(WEB_DIR / f, out / f)
    n_files = len(STATIC_FILES)
    n_bytes = sum((out / f).stat().st_size for f in STATIC_FILES)

    # 2) 切段。关键: 只切**有效路由范围** = 前缀范围 − 更具体子段。因为 BGP 是最长前缀匹配——
    #    被更具体段(自有 AS_PATH)覆盖的地址其实不走母段的路由, 不应算进母段。这些子段会作为各自的前缀
    #    出现(带自己的 path)。再把有效范围按 ipdb 切到 focus_cities, 跨城大段落进多个城市分片各带本城子段。
    gindex = geoip.GeoIndex(conn)
    city_set = set(cfg.get("focus_cities") or []) or None   # None=全部城市(未配置时)
    paths_by_pid = _paths_all(conn)
    items, parent, children = _forest(conn)
    info_by_pid = {r["pid"]: r for r in conn.execute(
        "SELECT p.id pid,p.prefix,p.start_num,p.end_num,p.origin_asn,p.province,p.n_paths "
        "FROM prefix p WHERE p.family=4")}

    buckets: dict[str, list] = {}     # city -> [rec]
    pid_city: dict[int, str] = {}     # pid -> 代表(焦点)城市
    n_overridden = 0
    for it in items:
        r = info_by_pid[it["id"]]
        holes = [(k["start"], k["end"]) for k in (children.get(it["id"]) or [])]
        eff = _subtract(it["start"], it["end"], holes)   # 有效路由范围(扣掉更具体子段)
        by_city: dict[str, list] = {}
        for es, ee in eff:
            for cs, ce, city, _prov in gindex.carve(es, ee, city_set):
                if city:
                    by_city.setdefault(city, []).append([cs, ce])
        if holes:
            n_overridden += 1
        if not by_city:
            continue
        pid_city[r["pid"]] = next(iter(by_city))
        base = {
            "pid": r["pid"], "prefix": r["prefix"],
            "origin_asn": r["origin_asn"], "origin_name": bgp.asn_name(r["origin_asn"] or 0),
            "province": r["province"], "n_paths": r["n_paths"],
            "paths": paths_by_pid.get(r["pid"], []),
        }
        for city, seglist in by_city.items():
            cidrs = _ranges_to_cidrs(seglist)   # 归纳为 CIDR(更紧凑)
            rec = dict(base)
            rec["nseg"] = len(cidrs)
            rec["segs"] = cidrs[:SEG_CAP]
            buckets.setdefault(city, []).append(rec)

    # 城市清单(按前缀数降序) + name->id
    names = sorted(buckets.keys(), key=lambda c: (-len(buckets[c]), c))
    cities, idmap = [], {}
    for i, name in enumerate(names, 1):
        cid = f"c{i:04d}"; idmap[name] = cid
        cities.append({"name": name, "id": cid, "n_prefix": len(buckets[name])})

    # 父子段(更大/更小段); cid 用代表城市
    cid_of = {pid: idmap.get(city) for pid, city in pid_city.items()}
    sup_map, sub_map = _hierarchy(items, parent, children, cid_of)

    # 写城市分片(本城观测多的靠前; PART_SIZE 二次切分)
    for c in cities:
        recs = buckets[c["name"]]
        recs.sort(key=lambda d: -(d["n_paths"] or 0))
        for d in recs:
            if d["pid"] in sup_map: d["sup"] = sup_map[d["pid"]]
            if d["pid"] in sub_map: d["sub"] = sub_map[d["pid"]]
        parts = max(1, -(-len(recs) // PART_SIZE))
        for p in range(parts):
            chunk = recs[p * PART_SIZE:(p + 1) * PART_SIZE]
            n_bytes += _write_json(data / "prefixes" / f"{c['id']}-{p}.json", chunk, pretty)
            n_files += 1
        c["parts"] = parts

    # 3) IP 索引: **全部** IPv4 前缀的 [start,end,pid,cid,prefix], 按 start 升序。子网搜索按 IP 找覆盖它的
    #     所有 greater prefix; cid=代表焦点城市(可加载完整记录), 落在非焦点城市的前缀 cid="" (只显示前缀串)。
    ipidx = [[r["start_num"], r["end_num"], r["id"], idmap.get(pid_city.get(r["id"])) or "", r["prefix"]]
             for r in conn.execute(
                 "SELECT id,start_num,end_num,prefix FROM prefix WHERE family=4 ORDER BY start_num")]
    n_bytes += _write_json(data / "ipindex.json", ipidx, pretty); n_files += 1

    # 4) index：统计 + 城市清单 + ASN 名称 + path 预制下拉 + focus
    st = report.stats(conn, cfg)
    # DFZ 可见性参考: n_paths(=观测到该前缀的 peer 数) 的 90 分位 ≈ 全表 peer 数。
    # 前端用 n_paths/dfz_ref 判定低可见(疑未入 DFZ)。
    npref = conn.execute(
        "SELECT n_paths FROM prefix ORDER BY n_paths "
        "LIMIT 1 OFFSET (SELECT CAST(COUNT(*)*0.9 AS INT) FROM prefix)").fetchone()
    dfz_ref = (npref["n_paths"] if npref else 0) or 1
    now = int(time.time())
    index = {
        "generated_ts": now,
        "generated_str": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)),
        "stats": {
            "prefixes": st["prefixes"], "pathobs": st["pathobs"],
        },
        "cities": cities,
        "asn_names": {str(a): v["name"] for a, v in bgp.ASN_REGISTRY.items()},
        "asn_ops": {str(a): v["op"] for a, v in bgp.ASN_REGISTRY.items() if v.get("op")},
        "path_presets": cfg.get("path_presets") or [],
        "focus_asns": bgp.resolve_asns(cfg.get("focus_asns") or []),
        "dfz_ref": dfz_ref,   # ≈ 全表 peer 数; 低可见判定基准
    }
    n_bytes += _write_json(data / "index.json", index, pretty); n_files += 1

    return {"out": str(out), "files": n_files, "bytes": n_bytes,
            "cities": len(cities), "prefixes": st["prefixes"]}
