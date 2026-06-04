"""RPKI ROA 路由起源验证(RFC 6811) —— 导出期把每条 (前缀,origin) 标成 Valid/Invalid/NotFound。

数据源(统一 schema `{asn, prefix, maxLength}`，一个解析器两站通吃):
  peeras: https://rpki.cloudflare.com/rpki.json (rpki-client 产出, ~930k VRP, 含 metadata.buildtime)
  dn42  : registry route/route6 的 `max-length`(本地仓, 无需联网) —— 与 IRR 同源、同步更新

管线:
  refresh(cfg)  下载/解析 -> cache/rpki/vrp.csv + meta.json(含 as_of 时间戳)。CLI `ipc rpki-import` / export 自动调。
  attach(con)   建 DuckDB `vrp` 表(无 vrp 缓存或开关关 -> 返回 None, 下游 has_rpki=False 自动 no-op)。
  classify(con) 用 vrp + route_origin range join 建 `rpki_status(pid,origin,rpki UTINYINT)`。

状态码(UTINYINT, 与前端 OriginStatus.svelte 一致): 0/NULL=NotFound 1=Valid 2=Invalid(ASN 不符) 3=Invalid(长度>maxLength)。
判定(RFC 6811): covering = vrp.ip_start<=route.ip_start AND vrp.ip_end>=route.ip_end(路由等于或更具体);
  matched = covering AND route.plen<=vrp.maxlen AND vrp.asn=origin。有 matched=>Valid; 仅 covering=>Invalid; 无 covering=>NotFound。
  Invalid 细分(he.net 风格): 覆盖 VRP 中存在 asn==origin 者(仅长度问题)=>invalid_len; 否则 invalid_asn。
"""
from __future__ import annotations

import calendar
import csv
import ipaddress
import json
import time
from pathlib import Path

from . import profile, util

RPKI_DIR = util.CACHE_DIR / "rpki"
VRP_CSV = RPKI_DIR / "vrp.csv"
META_JSON = RPKI_DIR / "meta.json"

CF_URL = "https://rpki.cloudflare.com/rpki.json"
DN42_URL = "https://dn42.burble.com/roa/dn42_roa_46.json"

NOTFOUND, VALID, INVALID_ASN, INVALID_LEN = 0, 1, 2, 3


def _parse_asn(a) -> int:
    s = str(a).strip().upper()
    if s.startswith("AS"):
        s = s[2:]
    return int(s)


def _parse_ts(s) -> int | None:
    """'2026-06-04T00:35:49Z' -> epoch(UTC)。失败返回 None。"""
    if not s:
        return None
    try:
        return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:  # noqa
        return None


def _rows_from_json(obj) -> list[tuple]:
    """Cloudflare/Routinator/burble 同形 JSON -> [(family, ip_start, ip_end, maxlen, asn)]。"""
    rows: list[tuple] = []
    for r in (obj.get("roas") or []):
        try:
            net = ipaddress.ip_network(str(r["prefix"]).strip(), strict=False)
            asn = _parse_asn(r["asn"])
            maxlen = int(r.get("maxLength") or net.prefixlen)
        except Exception:  # noqa
            continue
        fam = 4 if net.version == 4 else 6
        rows.append((fam, int(net.network_address), int(net.broadcast_address), net.prefixlen, maxlen, asn))
    return rows


def _rows_from_registry(cfg) -> list[tuple]:
    """dn42: registry route/route6 对象的 max-length 即 ROA(本地, 无需联网)。
    一个 route 对象可登记多条 origin(MOAS) -> 每个 origin 各出一条 VRP, 否则 MOAS 里
    非首个 origin 会被误判 Invalid。"""
    from . import registry
    data = registry.ensure_registry(cfg)
    rows: list[tuple] = []
    for sub, fam in (("route", 4), ("route6", 6)):
        for _name, kv in registry._read_dir(data, sub).items():
            pfx = registry._first(kv, sub)
            maxl = registry._first(kv, "max-length")
            if not pfx:
                continue
            try:
                net = ipaddress.ip_network(pfx.strip(), strict=False)
                maxlen = int(maxl) if maxl else net.prefixlen
            except Exception:  # noqa
                continue
            for origin in registry._all(kv, "origin"):
                try:
                    asn = _parse_asn(origin)
                except Exception:  # noqa
                    continue
                rows.append((fam, int(net.network_address), int(net.broadcast_address), net.prefixlen, maxlen, asn))
    return rows


def refresh(cfg: dict, force: bool = False) -> dict | None:
    """下载/解析 VRP -> cache/rpki/vrp.csv + meta.json。开关关 -> None。返回 meta(含 as_of/count/source)。"""
    if not profile.features(cfg).get("rpki", True):
        return None
    RPKI_DIR.mkdir(parents=True, exist_ok=True)
    site = profile.site(cfg)
    if site == "dn42":
        rows = _rows_from_registry(cfg)
        source, as_of = "dn42-registry", int(time.time())
    else:
        url = cfg.get("rpki_url") or CF_URL
        import requests
        util.log(f"  下载 RPKI VRP: {url}")
        obj = requests.get(url, timeout=300).json()
        rows = _rows_from_json(obj)
        source = url
        as_of = _parse_ts((obj.get("metadata") or {}).get("buildtime")) or int(time.time())
    if not rows:
        util.log("  ! RPKI VRP 为空, 跳过", err=True)
        return None
    with open(VRP_CSV, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    meta = {"as_of": as_of, "count": len(rows), "source": source,
            "as_of_str": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(as_of))}
    META_JSON.write_text(json.dumps(meta), encoding="utf-8")
    util.log(f"  RPKI VRP: {util.human(len(rows))} 条 (as of {meta['as_of_str']}) -> {VRP_CSV}")
    return meta


def attach(con, cfg: dict) -> dict | None:
    """建 DuckDB `vrp` 表; 无缓存/开关关返回 None。"""
    if not profile.features(cfg).get("rpki", True):
        return None
    if not (VRP_CSV.exists() and META_JSON.exists()):
        return None
    try:
        meta = json.loads(META_JSON.read_text(encoding="utf-8"))
    except Exception:  # noqa
        return None
    if not meta.get("count"):
        return None
    con.execute("DROP TABLE IF EXISTS vrp;")
    con.execute(f"""
        CREATE TABLE vrp AS SELECT
          column0::INT AS family, column1::UHUGEINT AS ip_start, column2::UHUGEINT AS ip_end,
          column3::INT AS vlen, column4::INT AS maxlen, column5::BIGINT AS asn
        FROM read_csv('{VRP_CSV.as_posix()}', header=false, auto_detect=false,
          columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR',
                    'column3':'VARCHAR','column4':'VARCHAR','column5':'VARCHAR'}});
    """)
    return meta


def classify(con) -> None:
    """需先有 route_origin(pid,family,ip_start,ip_end,plen,origin) 与 vrp 表 -> 建 rpki_status(pid,origin,rpki)。

    **覆盖判定按前缀长度分桶 -> 等值 hash join**(不用双不等式 range join: 110万×93万会退化成 nested-loop、跑不完)。
    覆盖 <=> 存在 VRP 前缀长度 vlen<=route.plen 且 route.ip_start 掩到 vlen 位 == vrp.ip_start。
    vlens 表枚举 vrp 里出现过的 (family, vlen) 及其块大小 p=2^(W-vlen)(在 Python 算, 避开 v6 的 2^128 字面量溢出)。
    """
    vl = con.execute("SELECT DISTINCT family, vlen FROM vrp WHERE vlen > 0").fetchall()
    parts = []
    for fam, vlen in vl:
        W = 32 if int(fam) == 4 else 128
        p = 1 << (W - int(vlen))
        if p >= (1 << 128):   # 仅 v6 vlen=0 才会到此(已被 WHERE vlen>0 排除), 双保险防 UHUGEINT 溢出
            continue
        parts.append(f"({int(fam)},{int(vlen)},{p}::UHUGEINT)")
    con.execute("DROP TABLE IF EXISTS vlens;")
    if parts:
        con.execute(f"CREATE TABLE vlens AS SELECT * FROM (VALUES {','.join(parts)}) v(family, vlen, p);")
    else:
        con.execute("CREATE TABLE vlens(family INT, vlen INT, p UHUGEINT);")
    # 候选键**物化**成普通列(family,vlen,key=route.ip_start 掩到 vlen 位), 再与 vrp 做纯三列等值 join ->
    # 保证 DuckDB 走 hash join(若把 key 写成内联表达式跨两表, 规划器会当残留过滤 -> 每桶全扫 -> 退化炸开)。
    con.execute("DROP TABLE IF EXISTS rpki_cand;")
    con.execute("""
        CREATE TABLE rpki_cand AS
        SELECT r.pid, r.origin, r.plen, r.family, vl.vlen, (r.ip_start // vl.p) * vl.p AS key
        FROM route_origin r
        JOIN vlens vl ON vl.family = r.family AND vl.vlen <= r.plen;
    """)
    con.execute("DROP TABLE IF EXISTS rpki_status;")
    con.execute(f"""
        CREATE TABLE rpki_status AS
        WITH cov AS (
            SELECT c.pid, c.origin,
                   bool_or(c.plen <= v.maxlen AND v.asn = c.origin) AS has_match,
                   bool_or(v.asn = c.origin)                        AS asn_ok
            FROM rpki_cand c
            JOIN vrp v ON v.family = c.family AND v.vlen = c.vlen AND v.ip_start = c.key
            GROUP BY c.pid, c.origin
        )
        SELECT pid, origin,
               CAST(CASE WHEN has_match THEN {VALID}
                         WHEN asn_ok   THEN {INVALID_LEN}
                         ELSE {INVALID_ASN} END AS UTINYINT) AS rpki
        FROM cov;
    """)
    con.execute("DROP TABLE IF EXISTS rpki_cand;")


def empty_status(con) -> None:
    con.execute("DROP TABLE IF EXISTS rpki_status;")
    con.execute("CREATE TABLE rpki_status(pid BIGINT, origin BIGINT, rpki UTINYINT);")
