"""IRR as-set 对象 —— 「客户锥」层级树(可展开/折叠)。参照 bgp.tools 的 as-set 页。

as-set 的 `members:` 可含 **ASN 和其它 as-set**(递归图)。用途 = 运营商声明它为哪些 AS(及其下游)路由,
供 bgpq4 生成前缀过滤。命名 `AS-FOO`(扁平) / `AS2914:AS-GLOBAL`(层级, 冒号表所有权)。

**静态站铁律: 绝不预展开**(最大锥可达 10万+ ASN, 如 AS-HURRICANE ~2.3万)。只存**一级成员边**, 前端点一层查一层:
  asset_set     (set_key, source, name, descr, n_members)            —— 一行一个 as-set
  asset_member  (set_key, ord, kind, val)                            —— 一级成员边; kind=asn(val='AS123') / set(val=子 set_key 或裸名)
  asset_memberof(member, parent_key)                                 —— 反查: 此 ASN/as-set 被哪些 as-set 直接包含

set_key = "SOURCE::NAME"(防跨库重名, 同 bgp.tools 的 RADB::AS-FOO)。子 set 成员按来源优先级解析成 set_key;
解析不到(库外)则存裸名, 前端展开时查无结果 => 标"未解析"叶子。

数据源: 各 IRR 的 as-set split / 合并 dump(部分与 irr.py 的合并 dump 同文件, 复用缓存)。dn42 走 registry data/as-set。
"""
from __future__ import annotations

import csv
import gzip
import json
import re
import time
from pathlib import Path

from . import profile, util

ASSET_DIR = util.CACHE_DIR / "asset"
SET_CSV = ASSET_DIR / "as_set.csv"
MEMBER_CSV = ASSET_DIR / "as_member.csv"
MEMBEROF_CSV = ASSET_DIR / "as_memberof.csv"
META_JSON = ASSET_DIR / "meta.json"

# 含 as-set 对象的 dump(as-set split 优先; 合并 dump 与 irr.py 复用同一缓存目录, 避免重下)。
DEFAULT_SOURCES: list[tuple[str, str]] = [
    ("RIPE", "https://ftp.ripe.net/ripe/dbase/split/ripe.db.as-set.gz"),
    ("RIPE-NONAUTH", "https://ftp.ripe.net/ripe/dbase/split/ripe-nonauth.db.as-set.gz"),
    ("APNIC", "https://ftp.apnic.net/pub/apnic/whois/apnic.db.as-set.gz"),
    ("ARIN", "https://ftp.arin.net/pub/rr/arin.db.gz"),
    ("AFRINIC", "https://ftp.afrinic.net/pub/dbase/afrinic.db.gz"),
    ("LACNIC", "https://irr.lacnic.net/lacnic.db.gz"),
    ("RADB", "ftp://ftp.radb.net/radb/dbase/radb.db.gz"),   # RADB 只走 FTP(大的第三方 as-set 如 AS-HURRICANE 在此)
]
# 子 set 名解析成 set_key 时的来源优先级(权威 RIR 优先, 同 IRRd 的 source ordering 思路)。
SOURCE_PRIORITY = ["RIPE", "APNIC", "ARIN", "AFRINIC", "LACNIC", "RIPE-NONAUTH", "RADB"]
AUTHORITATIVE = {"RIPE", "APNIC", "ARIN", "AFRINIC", "LACNIC", "DN42"}

_ASN_RE = re.compile(r"^AS\d+$", re.I)


def _split_members(vals: list[str]) -> list[str]:
    """把若干 members: 行(每行可逗号分隔, 可带 # 注释)拆成成员名列表。"""
    out: list[str] = []
    for v in vals:
        v = v.split("#")[0]
        for tok in v.replace(" ", ",").split(","):
            tok = tok.strip()
            if tok:
                out.append(tok)
    return out


def _parse_stream(fileobj, default_source: str):
    """流式解析 RPSL dump, 逐个 yield as-set 对象 (name, source, descr, [members 原始名])。"""
    cur: list[tuple[str, str]] = []

    def emit(cur):
        if not cur or cur[0][0] != "as-set":
            return None
        name = source = descr = None
        members: list[str] = []
        for k, v in cur:
            if k == "as-set" and name is None:
                name = v
            elif k == "members":
                members.append(v)
            elif k == "source" and source is None:
                source = v
            elif k == "descr" and descr is None:
                descr = v
        if not name:
            return None
        src = (source.split("#")[0].strip().upper() if source else default_source) or default_source
        return (name.strip().upper(), src, (descr or "").strip(), _split_members(members))

    for raw in fileobj:
        line = raw.decode("latin-1", "replace").rstrip("\r\n")
        if not line.strip():
            r = emit(cur)
            if r:
                yield r
            cur = []
        elif line[0] in " \t+":
            if cur:
                cur[-1] = (cur[-1][0], (cur[-1][1] + " " + line.strip()).strip())
        elif line[0] in "#%":
            continue
        else:
            k, sep, v = line.partition(":")
            if sep:
                cur.append((k.strip().lower(), v.strip()))
    r = emit(cur)
    if r:
        yield r


def _download(url: str, dest: Path, reuse: bool = True) -> bool:
    if not (reuse and dest.exists() and dest.stat().st_size > 1000):
        util.log(f"  下载 as-set 源: {url}")
    return util.download_file(url, dest, reuse=reuse)   # 支持 http(s) 与 ftp(RADB)


def _collect_peeras(cfg) -> tuple[dict, list[str]]:
    """返回 ({(name,source): {descr, members:[原始名]}}, sources_ok)。合并 dump 复用 irr.py 缓存目录。"""
    from . import irr  # 复用其缓存目录(合并 dump 已下载)
    sets: dict[tuple[str, str], dict] = {}
    sources_ok: list[str] = []
    srcs = cfg.get("asset_sources") or [{"name": n, "url": u} for n, u in DEFAULT_SOURCES]
    for s in srcs:
        name = (s.get("name") if isinstance(s, dict) else s[0])
        url = (s.get("url") if isinstance(s, dict) else s[1])
        fn = url.rstrip("/").split("/")[-1]
        # 合并 dump 与 irr 复用; as-set split 文件下到 asset 目录
        gz = (irr.IRR_DIR / fn) if (irr.IRR_DIR / fn).exists() else (ASSET_DIR / fn)
        if not _download(url, gz):
            continue
        n0 = len(sets)
        try:
            with gzip.open(gz, "rb") as fh:
                for nm, src, descr, members in _parse_stream(fh, name.upper()):
                    sets[(nm, src)] = {"descr": descr, "members": members}
        except Exception as e:  # noqa
            util.log(f"  ! as-set 解析失败({gz.name}): {e}", err=True)
            continue
        sources_ok.append(name)
        util.log(f"    {name}: as-set 累计 {util.human(len(sets))} (+{len(sets) - n0})")
    return sets, sources_ok


def _collect_dn42(cfg) -> tuple[dict, list[str]]:
    from . import registry
    data = registry.ensure_registry(cfg)
    sets: dict[tuple[str, str], dict] = {}
    for name, kv in registry._read_dir(data, "as-set").items():
        nm = (registry._first(kv, "as-set") or name).strip().upper()
        members = [v for k, v in kv if k == "members"]
        descr = registry._first(kv, "descr") or ""
        sets[(nm, "DN42")] = {"descr": descr, "members": _split_members(members)}
    return sets, (["DN42"] if sets else [])


def refresh(cfg: dict, force: bool = False) -> dict | None:
    """解析全部 as-set -> cache/asset/*.csv + meta.json。开关关 -> None。"""
    if not profile.features(cfg).get("asset", True):
        return None
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    if profile.site(cfg) == "dn42":
        sets, sources_ok = _collect_dn42(cfg)
    else:
        sets, sources_ok = _collect_peeras(cfg)
    if not sets:
        util.log("  ! as-set 无对象, 跳过", err=True)
        return None

    # 名字 -> 最佳来源(优先级), 用于把子 set 成员解析成 set_key。
    prio = {s: i for i, s in enumerate(SOURCE_PRIORITY)}
    name2src: dict[str, str] = {}
    for (nm, src) in sets:
        cur = name2src.get(nm)
        if cur is None or prio.get(src, 99) < prio.get(cur, 99):
            name2src[nm] = src

    def key(nm: str, src: str) -> str:
        return f"{src}::{nm}"

    set_rows: list[tuple] = []
    member_rows: list[tuple] = []
    memberof_rows: list[tuple] = []
    for (nm, src), obj in sets.items():
        sk = key(nm, src)
        n_mem = 0
        for ord_, m in enumerate(obj["members"]):
            mu = m.strip().upper()
            if not mu:
                continue
            if _ASN_RE.match(mu):
                val, kind = mu, "asn"
            else:
                # 子 as-set: 解析成最佳来源的 set_key; 库外则存裸名(前端展开查无 => 未解析叶子)
                bsrc = name2src.get(mu)
                val, kind = (key(mu, bsrc) if bsrc else mu), "set"
            member_rows.append((sk, ord_, kind, val))
            memberof_rows.append((val, sk))
            n_mem += 1
        set_rows.append((sk, src, nm, (obj["descr"] or "")[:200], n_mem))

    set_rows.sort(key=lambda r: r[0])
    member_rows.sort(key=lambda r: r[0])
    memberof_rows.sort(key=lambda r: r[0])
    with open(SET_CSV, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(set_rows)
    with open(MEMBER_CSV, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(member_rows)
    with open(MEMBEROF_CSV, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(memberof_rows)
    now = int(time.time())
    meta = {"as_of": now, "n_sets": len(set_rows), "n_edges": len(member_rows),
            "sources": sorted(set(sources_ok)), "authoritative": sorted(AUTHORITATIVE),
            "as_of_str": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(now))}
    META_JSON.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    util.log(f"  as-set: {util.human(len(set_rows))} 个集合 / {util.human(len(member_rows))} 条成员边 / {len(meta['sources'])} 源")
    return meta


def attach(con, cfg: dict) -> dict | None:
    """建 DuckDB as_set / as_set_member / as_memberof 表; 无缓存/开关关返回 None。"""
    if not profile.features(cfg).get("asset", True):
        return None
    if not (SET_CSV.exists() and MEMBER_CSV.exists() and META_JSON.exists()):
        return None
    try:
        meta = json.loads(META_JSON.read_text(encoding="utf-8"))
    except Exception:  # noqa
        return None
    if not meta.get("n_sets"):
        return None
    con.execute("DROP TABLE IF EXISTS as_set;")
    con.execute(f"""
        CREATE TABLE as_set AS SELECT
          column0 AS set_key, column1 AS source, column2 AS name, column3 AS descr, column4::INT AS n_members
        FROM read_csv('{SET_CSV.as_posix()}', header=false, auto_detect=false,
          columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR','column4':'VARCHAR'}});
    """)
    con.execute("DROP TABLE IF EXISTS as_set_member;")
    con.execute(f"""
        CREATE TABLE as_set_member AS SELECT
          column0 AS set_key, column1::INT AS ord, column2 AS kind, column3 AS val
        FROM read_csv('{MEMBER_CSV.as_posix()}', header=false, auto_detect=false,
          columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR'}});
    """)
    con.execute("DROP TABLE IF EXISTS as_memberof;")
    con.execute(f"""
        CREATE TABLE as_memberof AS SELECT column0 AS member, column1 AS parent_key
        FROM read_csv('{MEMBEROF_CSV.as_posix()}', header=false, auto_detect=false,
          columns={{'column0':'VARCHAR','column1':'VARCHAR'}});
    """)
    return meta
