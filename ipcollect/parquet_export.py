"""把 **DuckDB 工作库**(store)导出为 Parquet 数据集, 供 DuckDB-WASM 前端按 HTTP Range 查询(无后端)。

按 family 出**两套**(v4 无后缀 / v6 带 `_v6`), 前端按输入 IP 的 family 路由或 union(见 docs/DUCKDB_V6_REFACTOR.md):
  prefixes{,_v6}/   全部前缀, 按 ip_start 排序(子网搜索/父子段/pid 详情)。即 ipindex。
  paths{,_v6}/      每前缀去重 AS_PATH(<=PATH_CAP), 按 pid 排序(insight 抽屉)。
  pathsearch{,_v6}/ 全表一行/前缀(paths_blob+origin_asn+cc), 按 origin_asn 排序(不选国家时全局搜索)。
  geo{,_v6}/<cc>/   国家 working-set: 每 (pid,cc,city) 一行 + segs(本段范围) + paths_blob + prefix。
  meta.json         version + files(含 _v6) + counts + dfz_ref{,_v6} + countries + country_names(country_dim) +
                    cities + presets + focus_asns + asn_names/ops + asn org(asn_dim) + site_base。
另: ssg.generate 产出 c/<cc>.html 双语 SEO 落地页 + sitemap + robots。

**v4/v6 类型**: v4 的 ip_start/ip_end/segs 导成 **BIGINT**(前端按 number 处理, 行为不变);
v6 导成 **UHUGEINT**(DuckDB-WASM 给前端 BigInt, 比较隔离在 v6 路径)。geo 表非重叠 -> 代表 cc 用 ASOF join。
排序/分目录是性能命门(row-group min/max 行级裁剪); duckdb 溢出目录走真盘(store.connect 已配)。
"""
from __future__ import annotations

import csv
import ipaddress
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from . import bgp, geoip, profile, util


def _subtract(s: int, e: int, holes: list) -> list[tuple]:
    """从 [s,e] 扣掉若干 holes(不相交, 已在 [s,e] 内), 返回剩余区间。位宽无关, v4/v6 通用。
    有效路由范围 = 前缀范围 − 更具体子段(longest-prefix-match: 子段自有路由, 不归母段)。"""
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

PATH_CAP = 24
FILE_SIZE = "16MB"
PATHSEARCH_FILE_SIZE = "6MB"
# prefixes 切得更细 + 每文件 [min ip_start, max ip_end] 区间索引(prefixes_ip), 让精确 IP/子网查询
# 只读区间相交的那 1 个小文件(其余整文件跳过), 而非整套 ~24MB。约 2MB 分片 -> 实测单 IP 查 ~2MB(降 ~12x)。
# **必须单线程 + preserve_insertion_order 写**(见下), 否则多线程并行写令各文件 ip_start 不连续、跨满全表 ->
# 区间索引退化(每文件都覆盖全空间)、裁剪失效。同 pathsearch 的处理。
PREFIX_FILE_SIZE = "2MB"
# carve 时, 若一个前缀覆盖的 geo 段数 > 此值, 视为粗聚合 -> 退化国家级单段(防超大 v6/v4 聚合炸开)。
SEG_OVERLAP_CAP = 256
# 每个 (前缀,城市) 最多内嵌多少条 CIDR 子段(跨城大段会很多, 截断)。
SEG_CAP = 48


def _focus_countries(cfg: dict) -> set[str]:
    """哪些国家在侧栏给出城市下拉(导航用)。默认 CN + 配置 focus_geo_countries。
    注意: carve 现在**所有**国家都切到城市(一步到位), 这里只决定 UI 城市列表列哪些国家。"""
    s = {"CN"}
    s.update(cfg.get("focus_geo_countries") or [])
    return s


def _autnums(url: str) -> dict[int, str]:
    """APNIC autnums(handle 作 ASN 名), 缓存复用; 失败返回空(降级到 config 注册表)。"""
    import requests
    cache = util.CACHE_DIR / "autnums.txt"
    try:
        if not cache.exists() or cache.stat().st_size < 10000:
            util.log(f"  下载 ASN 名称表: {url}")
            cache.write_text(requests.get(url, timeout=180).text, encoding="utf-8", errors="replace")
    except Exception as e:  # noqa
        util.log(f"  ! autnums 下载失败({e}); ASN 名仅用 config 注册表", err=True)
        return {}
    out: dict[int, str] = {}
    for line in cache.read_text(encoding="utf-8", errors="replace").splitlines():
        p = line.strip().split(None, 1)
        if len(p) < 2 or not p[0].isdigit():
            continue
        full = p[1].rsplit(",", 1)[0].strip()
        handle = full.split(" - ", 1)[0].strip()
        if handle:
            out[int(p[0])] = handle[:40]
    return out


def _merge(ivs: list) -> list[tuple]:
    out: list[list] = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def copy_web(out_dir: str = "dist") -> int:
    """把已构建的 Svelte SPA(ipcollect/web/dist/)拷进 out_dir。返回拷贝文件数。"""
    out = Path(out_dir)
    if (out / "assets").exists():
        shutil.rmtree(out / "assets")
    webdist = Path(__file__).resolve().parent / "web" / "dist"
    if not webdist.exists():
        util.log("  ! web/dist 不存在 —— 请先在 ipcollect/web 跑 `npm ci && npm run build`", err=True)
        return 0
    n_files = 0
    for p in webdist.rglob("*"):
        if p.is_file():
            dst = out / p.relative_to(webdist)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst); n_files += 1
    return n_files


# ----------------------------------------------------------------------------
# 层状森林 + 有效路由切段(从 DuckDB prefix 读, 位宽无关 Python 整数算)
# ----------------------------------------------------------------------------
def _forest_duck(con, family: int):
    """某 family 前缀的层状(laminar)森林: 栈扫描得 children(pid->[直接子段])。"""
    # UHUGEINT 拆 hi/lo 取(原生快路径, 见 util.uhuge_halves); 避开 UHUGEINT->python/VARCHAR 慢转换。
    SH = util.SH64
    rows = con.execute(
        f"SELECT pid, {util.uhuge_halves('ip_start')}, {util.uhuge_halves('ip_end')} "
        f"FROM prefix WHERE family=? ORDER BY ip_start", [family]).fetchall()
    items = [{"id": int(r[0]), "start": r[1] * SH + r[2], "end": r[3] * SH + r[4]} for r in rows]
    items.sort(key=lambda x: (x["start"], -x["end"]))
    children: dict[int, list] = {}
    stack: list[dict] = []
    for it in items:
        while stack and stack[-1]["end"] < it["start"]:
            stack.pop()
        if stack:
            children.setdefault(stack[-1]["id"], []).append(it)
        stack.append(it)
    return items, children


def _segments_duck(con, cfg: dict, family: int, gindex) -> list[tuple]:
    """对每个前缀: 有效路由范围(自身 − 更具体子段)按 geo 切成各城市子段(所有国家都到城市), 每
    (pid,cc,city) 的子段**在 Python 里直接算成 CIDR 字符串列表**(精度安全, 前端不必再对 v6 128 位做 BigInt 运算)。
    返回 [(pid, cc, province, city, cidrs_space_joined, plen, origin_asn, n_paths), ...]。"""
    items, children = _forest_duck(con, family)
    info = {int(r[0]): r for r in con.execute(
        "SELECT pid, origin_asn, n_paths, plen FROM prefix WHERE family=?", [family]).fetchall()}
    addrcls = ipaddress.IPv4Address if family == 4 else ipaddress.IPv6Address
    out: list[tuple] = []
    done = 0
    for it in items:
        done += 1
        if done % 200000 == 0:
            util.log(f"  carve v{family}: {util.human(done)}/{util.human(len(items))} 前缀, {util.human(len(out))} 段")
        pid = it["id"]
        meta = info.get(pid)
        if not meta:
            continue
        holes = [(k["start"], k["end"]) for k in (children.get(pid) or [])]
        eff = _subtract(it["start"], it["end"], holes)
        groups: dict[tuple, list] = {}
        prov_of: dict[tuple, str] = {}
        for es, ee in eff:
            # cap: 超大聚合前缀(覆盖 >SEG_OVERLAP_CAP 个 geo 段)退化为国家级单段, 防 carve 炸开。
            for cs, ce, cc, prov, city in gindex.carve_cc(es, ee, cap=SEG_OVERLAP_CAP):
                key = (cc, city)
                groups.setdefault(key, []).append((cs, ce))
                prov_of[key] = prov
        for (cc, city), ivs in groups.items():
            cidrs: list[str] = []
            for s, e in _merge(ivs):
                for net in ipaddress.summarize_address_range(addrcls(s), addrcls(e)):
                    cidrs.append(str(net))
                    if len(cidrs) >= SEG_CAP:
                        break
                if len(cidrs) >= SEG_CAP:
                    break
            out.append((pid, cc, prov_of[(cc, city)], city, " ".join(cidrs),
                        meta[3], meta[1], meta[2]))
    return out


# ----------------------------------------------------------------------------
# geo working-set 导出(carve 切段 -> 逐国家 parquet) —— 仅 geo profile(peeras)用; dn42 不调。
# ----------------------------------------------------------------------------
def _carve_geo_dirs(con, cfg: dict, pq: Path, family: int, suffix: str, geodir: str) -> tuple[list, int]:
    """geo{geodir}/<cc>: carve 切段 -> seg 表 -> 每 (cc,city,pid) 一行 segs + paths_blob + prefix, 逐国家写。
    返回 (ccs, n_segs)。依赖已建好的 pp{suffix} 表(每前缀 paths_blob/best_path)。"""
    gindex = geoip.GeoIndexDuck(con, family)
    util.log(f"  geo v{family}: carve 切段(算 CIDR)...")
    segs = _segments_duck(con, cfg, family, gindex)   # 每行已是一个 (pid,cc,city) + 空格分隔 CIDR 串
    seg_csv = os.path.join(tempfile.gettempdir(), f"ipc_seg_{family}_{os.getpid()}.csv")
    with open(seg_csv, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(segs)
    con.execute("DROP TABLE IF EXISTS seg;")
    con.execute(f"""
        CREATE TABLE seg AS SELECT
            column0::BIGINT AS pid, column1 AS cc, nullif(column2,'') AS province,
            nullif(column3,'') AS city,
            string_split(column4, ' ') AS segs,            -- list<varchar> CIDR(精度安全, 前端直接显示)
            column5::BIGINT AS plen, column6::BIGINT AS origin_asn, column7::BIGINT AS n_paths
        FROM read_csv('{seg_csv}', header=false, auto_detect=false,
            columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                      'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR'}});
    """)
    os.remove(seg_csv)
    con.execute("DROP TABLE IF EXISTS geo_full;")
    con.execute(f"""
        CREATE TABLE geo_full AS
        SELECT g.cc, g.city, g.province, g.pid, pfx.prefix, g.plen, g.origin_asn, g.n_paths,
               g.segs, pp.paths_blob, pp.best_path
        FROM seg g
        LEFT JOIN pp{suffix} pp ON pp.pid = g.pid
        LEFT JOIN prefix pfx ON pfx.pid = g.pid;
    """)
    (pq / geodir).mkdir(parents=True, exist_ok=True)
    ccs = [r[0] for r in con.execute(
        "SELECT DISTINCT cc FROM geo_full WHERE cc IS NOT NULL ORDER BY cc").fetchall()]
    util.log(f"  geo v{family}: 逐国家写出 {len(ccs)} 个...")
    for cc in ccs:
        con.execute(f"""
            COPY (SELECT * FROM geo_full WHERE cc='{cc}' ORDER BY city NULLS FIRST, n_paths DESC)
            TO '{pq}/{geodir}/{cc}' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}',
                  ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
        """)
    return ccs, len(segs)


# ----------------------------------------------------------------------------
# 单 family 导出
# ----------------------------------------------------------------------------
def _export_family(con, cfg: dict, pq: Path, family: int, geo_on: bool = True) -> dict:
    suffix = "" if family == 4 else "_v6"
    iptype = "BIGINT" if family == 4 else "UHUGEINT"
    geodir = "geo" if family == 4 else "geo_v6"
    util.log(f"  === 导出 family v{family} (suffix='{suffix or '(none)'}', iptype={iptype}) ===")

    # prefixes{suffix}: 全部前缀, 代表 cc/prov/city 来自 pgeo(ASOF), ip 按 family 类型, 按 ip_start 排序。
    # 单线程 + preserve_insertion_order: 令各分片为「连续的 ip_start 区段」, 这样 prefixes_ip 区间索引
    # 才能把精确 IP/子网查询裁到 1 个文件(多线程并行写会打乱、每文件跨满全表 -> 索引失效)。
    (pq / f"prefixes{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          SELECT pid, prefix, ip_start::{iptype} AS ip_start, ip_end::{iptype} AS ip_end,
                 plen, family, origin_asn, n_origins, n_paths,
                 COALESCE(cc,'ZZ') AS cc, province, city
          FROM pgeo WHERE family={family} ORDER BY ip_start
        ) TO '{pq}/prefixes{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PREFIX_FILE_SIZE}',
              ROW_GROUP_SIZE 20000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    # paths{suffix}: 每前缀去重 path(<=PATH_CAP), 按 pid 排序。
    (pq / f"paths{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
          WITH p AS (
            SELECT pid, ' ' || path_clean || ' ' AS path_str,
                   list_transform(string_split(path_clean,' '), x -> TRY_CAST(x AS BIGINT)) AS path_arr,
                   path_len, n_peers,
                   row_number() OVER (PARTITION BY pid ORDER BY path_len ASC, n_peers DESC) AS rn
            FROM pathobs WHERE family={family}
          )
          SELECT pid, path_str, path_arr, path_len, n_peers, (rn=1) AS is_best
          FROM p WHERE rn <= {PATH_CAP} ORDER BY pid
        ) TO '{pq}/paths{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}', OVERWRITE_OR_IGNORE);
    """)

    # pp{suffix}: 每前缀 paths_blob(连续序列 LIKE 用) + best_path。从已写的 paths parquet 聚合(列存可溢出)。
    con.execute(f"DROP TABLE IF EXISTS pp{suffix};")
    con.execute(f"""
        CREATE TABLE pp{suffix} AS
        SELECT pid, string_agg(path_str, '|') AS paths_blob,
               any_value(path_str) FILTER (WHERE is_best) AS best_path
        FROM read_parquet('{pq}/paths{suffix}/*.parquet') GROUP BY pid;
    """)

    # geo working-set(carve 切段 + 逐国家 parquet): 仅 geo profile。dn42(geo_on=False)整段跳过, 无 geo 目录。
    if geo_on:
        ccs, n_segs = _carve_geo_dirs(con, cfg, pq, family, suffix, geodir)
    else:
        ccs, n_segs = [], 0

    # pathsearch{suffix}: 全表一行/前缀, 按 origin_asn 排序(单线程顺序写 -> 每文件连续 origin 区间)。
    (pq / f"pathsearch{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          SELECT p.pid, p.prefix, COALESCE(p.cc,'ZZ') AS cc, p.origin_asn, p.n_paths,
                 pp.paths_blob, pp.best_path
          FROM pgeo p LEFT JOIN pp{suffix} pp ON pp.pid = p.pid
          WHERE p.family={family} ORDER BY p.origin_asn NULLS LAST
        ) TO '{pq}/pathsearch{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PATHSEARCH_FILE_SIZE}',
              ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    n_prefix = con.execute("SELECT count(*) FROM prefix WHERE family=?", [family]).fetchone()[0]
    n_paths = con.execute("SELECT count(*) FROM pathobs WHERE family=?", [family]).fetchone()[0]
    dfz_ref = con.execute(
        "SELECT quantile_cont(n_paths, 0.9) FROM prefix WHERE family=?", [family]).fetchone()[0] or 1
    return {"suffix": suffix, "geodir": geodir, "ccs": ccs, "n_prefix": int(n_prefix),
            "n_paths": int(n_paths), "n_segs": n_segs, "dfz_ref": int(round(dfz_ref))}


# ----------------------------------------------------------------------------
# 主导出
# ----------------------------------------------------------------------------
def export(cfg: dict, con, out_dir: str = "dist") -> dict:
    """从 DuckDB 工作库(con)导出 Parquet 数据集(v4 + v6)。"""
    out = Path(out_dir)
    data = out / "data"
    pq = data / "parquet"
    if pq.exists():
        shutil.rmtree(pq)
    pq.mkdir(parents=True, exist_ok=True)

    n_files = copy_web(out_dir)

    geo_on = profile.features(cfg)["geo"]   # peeras=True(现状); dn42=False(无地理: pgeo 不连 geo, 无国家 SSG)

    # 代表 geo(每前缀网络地址点查, geo 非重叠 -> ASOF 取 start<=ip_start 的最近段, 再校验 <=end)。
    # geo 关闭时(无 geo 表)退化为不连地理的 pgeo(cc/province/city 全 NULL), 下游 COALESCE 成 'ZZ'。
    con.execute("DROP TABLE IF EXISTS pgeo;")
    if geo_on:
        con.execute("""
            CREATE TABLE pgeo AS
            SELECT p.pid, p.family, p.prefix, p.ip_start, p.ip_end, p.plen,
                   p.origin_asn, p.n_origins, p.n_paths,
                   CASE WHEN g.start_num IS NOT NULL AND p.ip_start <= g.end_num THEN g.cc END AS cc,
                   CASE WHEN g.start_num IS NOT NULL AND p.ip_start <= g.end_num THEN g.province END AS province,
                   CASE WHEN g.start_num IS NOT NULL AND p.ip_start <= g.end_num THEN g.city END AS city
            FROM prefix p
            ASOF LEFT JOIN geo g ON p.family = g.family AND p.ip_start >= g.start_num;
        """)
    else:
        con.execute("""
            CREATE TABLE pgeo AS
            SELECT p.pid, p.family, p.prefix, p.ip_start, p.ip_end, p.plen,
                   p.origin_asn, p.n_origins, p.n_paths,
                   CAST(NULL AS VARCHAR) AS cc, CAST(NULL AS VARCHAR) AS province,
                   CAST(NULL AS VARCHAR) AS city
            FROM prefix p;
        """)

    families = [r[0] for r in con.execute(
        "SELECT DISTINCT family FROM prefix ORDER BY family").fetchall()]
    fam_results = {f: _export_family(con, cfg, pq, f, geo_on) for f in families}

    # ASN 名称(APNIC autnums + 注册表) + org(asn_dim), 只留数据里出现过的 ASN。
    autnums = _autnums(cfg.get("autnums_url") or "https://thyme.apnic.net/current/data-used-autnums")
    seen: set[int] = set()
    for f in families:
        suf = fam_results[f]["suffix"]
        for r in con.execute(
                f"SELECT DISTINCT unnest(path_arr) a FROM read_parquet('{pq}/paths{suf}/*.parquet')").fetchall():
            if r[0] is not None:
                seen.add(int(r[0]))
    for r in con.execute("SELECT DISTINCT origin_asn FROM prefix WHERE origin_asn IS NOT NULL").fetchall():
        seen.add(int(r[0]))
    asnames = {a: autnums[a] for a in seen if a in autnums}
    for e in (cfg.get("asn_registry") or []):
        if str(e.get("asn", "")).isdigit() and e.get("name"):
            asnames[int(e["asn"])] = e["name"]
    (data / "asnames.json").write_text(
        json.dumps({str(k): v for k, v in asnames.items()}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    # asn org(GeoLite asn_dim), 只留出现过的
    asnorg = {}
    if con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='asn_dim'").fetchone()[0]:
        for a, o in con.execute("SELECT asn, org FROM asn_dim").fetchall():
            if int(a) in seen:
                asnorg[str(int(a))] = o
    (data / "asnorg.json").write_text(
        json.dumps(asnorg, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    util.log(f"  asnames.json: {len(asnames)} 名; asnorg.json: {len(asnorg)} org")

    # 文件清单 + 区间索引(前端 HTTP 不能 glob)
    def _rel(sub):
        d = pq / sub
        return sorted(str(p.relative_to(pq)).replace("\\", "/")
                      for p in d.rglob("*.parquet")) if d.exists() else []

    def _pid_index(file_list):
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(pid), max(pid) FROM read_parquet('{pq}/{f}')").fetchone()
            if lo is not None:
                out_.append({"f": f, "lo": int(lo), "hi": int(hi)})
        out_.sort(key=lambda e: e["lo"])
        return out_

    def _ip_index_v4(file_list):
        # 每文件 [min ip_start, max ip_end] 区间(前端按与查询 [start,end] 相交裁剪文件)。
        # **仅 v4**: v4 的 ip 列是 BIGINT(精确)。v6 的 UHUGEINT 写进 parquet 会退化成 DOUBLE(有损,
        # 边界可偏差 ~2^76), 据此裁剪有"误跳过覆盖文件"的风险; 且 v6 prefixes 仅 1~2 个小文件、收益甚微,
        # 故 v6 不建索引(前端 prefixesFilesForRange 对 v6 回退读全部, 行为不变)。
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(ip_start), max(ip_end) FROM read_parquet('{pq}/{f}')").fetchone()
            if lo is not None:
                out_.append({"f": f, "lo": int(lo), "hi": int(hi)})
        out_.sort(key=lambda e: e["lo"])
        return out_

    def _origin_index(file_list):
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(origin_asn), max(origin_asn) FROM read_parquet('{pq}/{f}')").fetchone()
            out_.append({"f": f, "lo": (int(lo) if lo is not None else None),
                         "hi": (int(hi) if hi is not None else None)})
        return out_

    files: dict = {}
    for f in families:
        r = fam_results[f]; suf = r["suffix"]; gd = r["geodir"]
        files[f"prefixes{suf}"] = _rel(f"prefixes{suf}")
        if f == 4:   # v4 only(见 _ip_index_v4: v6 的 ip 列在 parquet 里是有损 DOUBLE, 不建索引)
            files["prefixes_ip"] = _ip_index_v4(files["prefixes"])
        files[f"paths{suf}"] = _rel(f"paths{suf}")
        files[f"pathsearch{suf}"] = _rel(f"pathsearch{suf}")
        files[f"paths_pid{suf}"] = _pid_index(files[f"paths{suf}"])
        files[f"pathsearch_origin{suf}"] = _origin_index(files[f"pathsearch{suf}"])
        files[("geo" if f == 4 else "geo_v6")] = {cc: _rel(f"{gd}/{cc}") for cc in r["ccs"]}

    # 国家清单(union 两 family) + 双语名(country_dim) + focus 国家城市清单(侧栏导航)。
    # geo 关闭(dn42)则全空 —— 无 country_dim 表、无地理可言。
    countries: list = []
    country_names: dict = {}
    country_names_en: dict = {}
    focus_cc: list = []
    cities: dict = {}
    if geo_on:
        countries = [{"cc": r[0], "n_prefix": int(r[1])} for r in con.execute(
            "SELECT COALESCE(cc,'ZZ') cc, count(*) c FROM pgeo WHERE cc IS NOT NULL GROUP BY 1 ORDER BY c DESC").fetchall()]
        cn_rows = con.execute("SELECT cc, name_zh, name_en FROM country_dim").fetchall()
        country_names = {r[0]: r[1] for r in cn_rows if r[1]}
        country_names_en = {r[0]: r[2] for r in cn_rows if r[2]}
        # 城市统计从 v4 seg 难取(seg 表已被 v6 覆盖); 改从 pgeo 的代表 city 取(够导航用)。
        focus_cc = sorted(_focus_countries(cfg))
        for cc in focus_cc:
            rows = con.execute(
                "SELECT city, count(*) c FROM pgeo WHERE cc=? AND city IS NOT NULL GROUP BY city ORDER BY c DESC", [cc]).fetchall()
            if rows:
                cities[cc] = [{"name": r[0], "n_prefix": int(r[1])} for r in rows]

    n_prefix_total = sum(fam_results[f]["n_prefix"] for f in families)
    n_paths_total = sum(fam_results[f]["n_paths"] for f in families)
    n_segs_total = sum(fam_results[f]["n_segs"] for f in families)
    now = int(time.time())
    import hashlib as _hashlib
    version = _hashlib.sha1(json.dumps(
        {"files": files, "n": n_prefix_total, "p": n_paths_total, "ts": now},
        sort_keys=True, default=str).encode()).hexdigest()[:12]

    counts = {"prefixes": fam_results.get(4, {}).get("n_prefix", 0),
              "prefixes_v6": fam_results.get(6, {}).get("n_prefix", 0),
              "paths": fam_results.get(4, {}).get("n_paths", 0),
              "paths_v6": fam_results.get(6, {}).get("n_paths", 0),
              "segments": n_segs_total}
    meta = {
        "version": version,
        "files": files,
        "generated_ts": now,
        "generated_str": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)),
        "scope": "global",
        "families": families,
        "collectors": [c for c in (cfg.get("mrt_collectors") or [cfg.get("mrt_collector")]) if c],
        "site_base": cfg.get("site_base") or "https://peer.as",
        "counts": counts,
        "dfz_ref": fam_results.get(4, {}).get("dfz_ref", 1),
        "dfz_ref_v6": fam_results.get(6, {}).get("dfz_ref", 1),
        "countries": countries,
        "country_names": country_names,
        "country_names_en": country_names_en,
        "focus_countries": focus_cc,
        "cities": cities,
        "path_presets": cfg.get("path_presets") or [],
        "focus_asns": bgp.resolve_asns(cfg.get("focus_asns") or []),
        "asn_names": {str(a): v["name"] for a, v in bgp.ASN_REGISTRY.items()},
        "asn_names_en": {str(a): v["name_en"] for a, v in bgp.ASN_REGISTRY.items() if v.get("name_en")},
        "asn_ops": {str(a): v["op"] for a, v in bgp.ASN_REGISTRY.items() if v.get("op")},
    }
    data.mkdir(parents=True, exist_ok=True)
    (data / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # SSG(SEO 落地页) —— 读 pgeo(代表 cc)取各国 top origin。geo 关闭(dn42)则无国家落地页(Phase2 改按 ASN)。
    if geo_on:
        from . import ssg
        n_ssg = ssg.generate(out, meta, con, asnames)
    else:
        n_ssg = 0

    total_bytes = sum(p.stat().st_size for p in pq.rglob("*.parquet"))
    n_pqfiles = sum(1 for _ in pq.rglob("*.parquet"))
    return {"out": str(out), "parquet_files": n_pqfiles, "parquet_bytes": total_bytes,
            "prefixes": n_prefix_total, "paths": n_paths_total, "segments": n_segs_total,
            "countries": len(countries), "ssg_pages": n_ssg,
            "v4": fam_results.get(4, {}).get("n_prefix", 0),
            "v6": fam_results.get(6, {}).get("n_prefix", 0)}
