"""IRR route/route6 对象 —— 导出期把每条 (前缀,origin) 标成 present/mismatch/not-found，并产出 route 对象明细供详情面板。

与 RPKI 不同: IRR 是**精确前缀 + 精确 origin** 匹配(无 maxLength 覆盖语义), 且**无 Invalid**, 只有有没有登记。
可信度低于 RPKI(第三方库任何人可注册) -> 每条对象标**来源库 + 权威/非权威**(bgp.tools 的 unauthenticated 思路)。

数据源:
  peeras: 各 IRR 的 gzip RPSL dump(RIPE/APNIC/ARIN/AFRINIC/LACNIC 权威 + RADB 第三方)。某源失败只跳过该源。
  dn42  : registry route/route6 对象即 IRR(本地仓, source=DN42, 权威)。

管线:
  refresh(cfg)  下载/解析 route(6) -> cache/irr/route.csv + meta.json。CLI `ipc irr-import` / export 自动按需调。
  attach(con)   建 DuckDB `irr_route(family,ip_start,ip_end,plen,origin,source)` 表; 无缓存/开关关 -> None。
  classify(con) 精确前缀 join route_origin -> `irr_status(pid,origin,irr UTINYINT)`。

状态码(UTINYINT, 与前端一致): 0/NULL=not-found 1=present(有相符 origin 的对象) 2=mismatch(有对象但 origin 全不符)。
"""
from __future__ import annotations

import csv
import gzip
import ipaddress
import json
import time
from pathlib import Path

from . import profile, util

IRR_DIR = util.CACHE_DIR / "irr"
ROUTE_CSV = IRR_DIR / "route.csv"
META_JSON = IRR_DIR / "meta.json"

# (默认来源库名, dump URL)。RPSL 对象自带 `source:` 时以对象为准(RADB dump 内混了被镜像库)。
DEFAULT_SOURCES: list[tuple[str, str]] = [
    ("RIPE", "https://ftp.ripe.net/ripe/dbase/split/ripe.db.route.gz"),
    ("RIPE", "https://ftp.ripe.net/ripe/dbase/split/ripe.db.route6.gz"),
    ("RIPE-NONAUTH", "https://ftp.ripe.net/ripe/dbase/split/ripe-nonauth.db.route.gz"),
    ("RIPE-NONAUTH", "https://ftp.ripe.net/ripe/dbase/split/ripe-nonauth.db.route6.gz"),
    ("APNIC", "https://ftp.apnic.net/pub/apnic/whois/apnic.db.route.gz"),
    ("APNIC", "https://ftp.apnic.net/pub/apnic/whois/apnic.db.route6.gz"),
    ("ARIN", "https://ftp.arin.net/pub/rr/arin.db.gz"),
    ("AFRINIC", "https://ftp.afrinic.net/pub/dbase/afrinic.db.gz"),
    ("LACNIC", "https://irr.lacnic.net/lacnic.db.gz"),
    ("RADB", "ftp://ftp.radb.net/radb/dbase/radb.db.gz"),   # RADB 只走 FTP(requests 不认 ftp:// -> util.download_file)
]
# 权威(RIR 直营, 资源持有人经验证)来源库 —— 前端据此标 trust。其余为第三方(开放注册)。
AUTHORITATIVE = {"RIPE", "APNIC", "ARIN", "AFRINIC", "LACNIC", "DN42"}


def _emit(cur: list[tuple[str, str]], default_source: str):
    """一个 RPSL 对象(attr 列表) -> (family, ip_start, ip_end, plen, origin, source) 或 None。"""
    if not cur:
        return None
    k0 = cur[0][0]
    if k0 not in ("route", "route6"):
        return None
    pfx = origin = source = None
    for k, v in cur:
        if k == k0 and pfx is None:
            pfx = v
        elif k == "origin" and origin is None:
            origin = v
        elif k == "source" and source is None:
            source = v
    if not pfx or not origin:
        return None
    try:
        net = ipaddress.ip_network(pfx.split("#")[0].strip(), strict=False)
        o = origin.split("#")[0].strip().upper()
        if o.startswith("AS"):
            o = o[2:]
        o = int(o)
    except Exception:  # noqa
        return None
    fam = 4 if net.version == 4 else 6
    src = (source.split("#")[0].strip().upper() if source else default_source) or default_source
    return (fam, int(net.network_address), int(net.broadcast_address), net.prefixlen, o, src)


def _parse_stream(fileobj, default_source: str):
    """流式解析 RPSL dump(空行分隔的 attr:value 块) -> 逐个 yield route(6) 元组。"""
    cur: list[tuple[str, str]] = []
    for raw in fileobj:
        line = raw.decode("latin-1", "replace").rstrip("\r\n")
        if not line.strip():
            r = _emit(cur, default_source)
            if r:
                yield r
            cur = []
        elif line[0] in " \t+":          # RPSL 续行
            if cur:
                cur[-1] = (cur[-1][0], (cur[-1][1] + " " + line.strip()).strip())
        elif line[0] in "#%":            # 注释
            continue
        else:
            k, sep, v = line.partition(":")
            if sep:
                cur.append((k.strip().lower(), v.strip()))
    r = _emit(cur, default_source)
    if r:
        yield r


def _download(url: str, dest: Path) -> bool:
    util.log(f"  下载 IRR: {url}")
    return util.download_file(url, dest)   # 支持 http(s) 与 ftp(RADB)


def _rows_from_registry(cfg) -> tuple[list[tuple], list[str]]:
    """dn42: registry route/route6 即 IRR(source=DN42, 权威)。"""
    from . import registry
    data = registry.ensure_registry(cfg)
    rows: list[tuple] = []
    for sub, fam in (("route", 4), ("route6", 6)):
        for _name, kv in registry._read_dir(data, sub).items():
            pfx = registry._first(kv, sub)
            if not pfx:
                continue
            try:
                net = ipaddress.ip_network(pfx.strip(), strict=False)
            except Exception:  # noqa
                continue
            # 一个 route 对象可登记多条 origin(MOAS) -> 每个 origin 各出一条, 否则 MOAS 里
            # 非首个 origin 会被误判为 mismatch/not-found。
            for origin in registry._all(kv, "origin"):
                try:
                    o = origin.strip().upper()
                    if o.startswith("AS"):
                        o = o[2:]
                    o = int(o)
                except Exception:  # noqa
                    continue
                rows.append((fam, int(net.network_address), int(net.broadcast_address), net.prefixlen, o, "DN42"))
    return rows, ["DN42"]


def refresh(cfg: dict, force: bool = False) -> dict | None:
    """下载/解析全部 IRR route 对象 -> cache/irr/route.csv + meta.json。开关关 -> None。某源失败仅跳过。"""
    if not profile.features(cfg).get("irr", True):
        return None
    IRR_DIR.mkdir(parents=True, exist_ok=True)
    seen: set[tuple] = set()      # 去重键 = 整行(含 source) -> 同对象在多库各留一行供明细
    sources_ok: list[str] = []

    if profile.site(cfg) == "dn42":
        rows, sources_ok = _rows_from_registry(cfg)
        for r in rows:
            seen.add(r)
    else:
        srcs = cfg.get("irr_sources") or [{"name": n, "url": u} for n, u in DEFAULT_SOURCES]
        for s in srcs:
            name = (s.get("name") if isinstance(s, dict) else s[0])
            url = (s.get("url") if isinstance(s, dict) else s[1])
            gz = IRR_DIR / (url.rstrip("/").split("/")[-1])
            if not _download(url, gz):
                continue
            n0 = len(seen)
            try:
                with gzip.open(gz, "rb") as fh:
                    for r in _parse_stream(fh, name.upper()):
                        seen.add(r)
            except Exception as e:  # noqa
                util.log(f"  ! IRR 解析失败({gz.name}): {e}", err=True)
                continue
            sources_ok.append(name)
            util.log(f"    {name}: +{util.human(len(seen) - n0)} route 对象")

    if not seen:
        util.log("  ! IRR 无任何对象(全部源失败?), 跳过", err=True)
        return None
    with open(ROUTE_CSV, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(sorted(seen))
    now = int(time.time())
    meta = {"as_of": now, "count": len(seen), "sources": sorted(set(sources_ok)),
            "authoritative": sorted(AUTHORITATIVE),
            "as_of_str": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(now))}
    META_JSON.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    util.log(f"  IRR route: {util.human(len(seen))} 对象 / {len(sources_ok)} 源 -> {ROUTE_CSV}")
    return meta


def attach(con, cfg: dict) -> dict | None:
    """建 DuckDB `irr_route` 表; 无缓存/开关关返回 None。"""
    if not profile.features(cfg).get("irr", True):
        return None
    if not (ROUTE_CSV.exists() and META_JSON.exists()):
        return None
    try:
        meta = json.loads(META_JSON.read_text(encoding="utf-8"))
    except Exception:  # noqa
        return None
    if not meta.get("count"):
        return None
    con.execute("DROP TABLE IF EXISTS irr_route;")
    con.execute(f"""
        CREATE TABLE irr_route AS SELECT
          column0::INT AS family, column1::UHUGEINT AS ip_start, column2::UHUGEINT AS ip_end,
          column3::INT AS plen, column4::BIGINT AS origin, column5 AS source
        FROM read_csv('{ROUTE_CSV.as_posix()}', header=false, auto_detect=false,
          columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR',
                    'column3':'VARCHAR','column4':'VARCHAR','column5':'VARCHAR'}});
    """)
    return meta


def classify(con) -> None:
    """需先有 route_origin 与 irr_route -> 建 irr_status(pid,origin,irr)。精确前缀(ip_start/ip_end 相等)匹配。"""
    con.execute("DROP TABLE IF EXISTS irr_status;")
    con.execute("""
        CREATE TABLE irr_status AS
        WITH ro AS (SELECT DISTINCT pid, family, ip_start, ip_end, origin FROM route_origin),
        m AS (
            SELECT ro.pid, ro.origin,
                   bool_or(ir.origin = ro.origin) AS has_origin
            FROM ro JOIN irr_route ir
              ON ir.family = ro.family AND ir.ip_start = ro.ip_start AND ir.ip_end = ro.ip_end
            GROUP BY ro.pid, ro.origin
        )
        SELECT pid, origin,
               CAST(CASE WHEN has_origin THEN 1 ELSE 2 END AS UTINYINT) AS irr
        FROM m;
    """)


def empty_status(con) -> None:
    con.execute("DROP TABLE IF EXISTS irr_status;")
    con.execute("CREATE TABLE irr_status(pid BIGINT, origin BIGINT, irr UTINYINT);")
