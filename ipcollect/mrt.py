"""MRT (RIPE rrc00 RIB) 下载 + 快速流式解析 + 入库。

自写的 TABLE_DUMP_V2 二进制解析 (RFC 6396), 比 mrtparse 快很多:
  * 流式 gzip, 不解压全表进内存;
  * 焦点 ASN 的 4 字节大端模式作前置过滤, 跳过 99% 不相关前缀;
  * 只对命中的前缀做完整属性解析。
"""
from __future__ import annotations

import gzip
import os
import struct
import time
from typing import Callable, Iterator, Optional

from . import bgp, config, db, geoip, util

# MRT / TABLE_DUMP_V2 常量
MRT_TABLE_DUMP_V2 = 13
ST_PEER_INDEX_TABLE = 1
ST_RIB_IPV4_UNICAST = 2
ST_RIB_IPV6_UNICAST = 4
ST_RIB_IPV4_UNICAST_ADDPATH = 8
ST_RIB_IPV6_UNICAST_ADDPATH = 10
ATTR_AS_PATH = 2

_HDR = struct.Struct(">IHHI")


# ----------------------------------------------------------------------------
# 下载
# ----------------------------------------------------------------------------
def latest_bview_url(cfg: dict) -> str:
    import requests

    base = cfg["mrt_base_url"].rstrip("/")
    coll = cfg["mrt_collector"]
    root = f"{base}/{coll}/"
    months = _list_links(root, r"20\d\d\.\d\d/")
    if not months:
        raise RuntimeError(f"无法在 {root} 列出月份目录")
    month = sorted(months)[-1]
    murl = root + month
    files = _list_links(murl, r"bview\.\d{8}\.\d{4}\.gz")
    if not files:
        raise RuntimeError(f"无法在 {murl} 列出 bview 文件")
    latest = sorted(files)[-1]
    return murl + latest


def _list_links(url: str, pattern: str) -> list[str]:
    import re
    import requests

    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return sorted(set(re.findall(pattern, r.text)))


def download(url: str, dest: Optional[str] = None, force: bool = False) -> str:
    import requests

    util.ensure_dirs()
    if dest is None:
        dest = str(util.MRT_CACHE_DIR / os.path.basename(url))
    if os.path.exists(dest) and not force:
        # 校验大小
        try:
            head = requests.head(url, timeout=30)
            remote = int(head.headers.get("content-length", 0))
        except Exception:
            remote = 0
        local = os.path.getsize(dest)
        if remote == 0 or local == remote:
            util.log(f"  复用已下载 MRT: {dest} ({util.human_bytes(local)})")
            return dest
        util.log(f"  本地大小 {local} != 远端 {remote}, 重新下载")
    util.log(f"  下载 {url}")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        last = time.time()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                done += len(chunk)
                if time.time() - last > 2:
                    pct = f"{done/total*100:.0f}%" if total else "?"
                    util.log(f"    {util.human_bytes(done)} / {util.human_bytes(total)} ({pct})")
                    last = time.time()
        os.replace(tmp, dest)
    util.log(f"  下载完成: {dest} ({util.human_bytes(done)})")
    return dest


# ----------------------------------------------------------------------------
# 解析
# ----------------------------------------------------------------------------
def _readn(f, n: int) -> bytes:
    buf = f.read(n)
    if len(buf) == n or len(buf) == 0:
        return buf
    # gzip 流偶尔短读, 补齐
    parts = [buf]
    got = len(buf)
    while got < n:
        more = f.read(n - got)
        if not more:
            break
        parts.append(more)
        got += len(more)
    return b"".join(parts)


def _parse_peer_index(body: bytes) -> list[tuple[Optional[int], Optional[str]]]:
    import socket

    off = 4  # collector_bgp_id
    view_len = int.from_bytes(body[off:off + 2], "big"); off += 2
    off += view_len
    peer_count = int.from_bytes(body[off:off + 2], "big"); off += 2
    peers: list[tuple[Optional[int], Optional[str]]] = []
    for _ in range(peer_count):
        ptype = body[off]; off += 1
        off += 4  # peer_bgp_id
        if ptype & 0x01:  # IPv6
            ip = socket.inet_ntop(socket.AF_INET6, body[off:off + 16]); off += 16
        else:
            ip = socket.inet_ntop(socket.AF_INET, body[off:off + 4]); off += 4
        if ptype & 0x02:  # 4-byte ASN
            asn = int.from_bytes(body[off:off + 4], "big"); off += 4
        else:
            asn = int.from_bytes(body[off:off + 2], "big"); off += 2
        peers.append((asn, ip))
    return peers


def _parse_as_path_value(val: bytes) -> list[int]:
    asns: list[int] = []
    i, n = 0, len(val)
    while i + 2 <= n:
        seg_len = val[i + 1]
        i += 2
        for _ in range(seg_len):
            if i + 4 > n:
                return asns
            asns.append(int.from_bytes(val[i:i + 4], "big"))
            i += 4
    return asns


def _parse_attrs_aspath(attrs: bytes) -> list[int]:
    i, n = 0, len(attrs)
    while i + 3 <= n:
        flags = attrs[i]
        tcode = attrs[i + 1]
        i += 2
        if flags & 0x10:  # extended length
            if i + 2 > n:
                break
            alen = int.from_bytes(attrs[i:i + 2], "big"); i += 2
        else:
            alen = attrs[i]; i += 1
        val = attrs[i:i + alen]; i += alen
        if tcode == ATTR_AS_PATH:
            return _parse_as_path_value(val)
    return []


def _parse_rib_body(body: bytes, addpath: bool):
    plen = body[4]
    nb = (plen + 7) // 8
    pfx_bytes = body[5:5 + nb]
    off = 5 + nb
    entry_count = int.from_bytes(body[off:off + 2], "big"); off += 2
    entries = []
    n = len(body)
    for _ in range(entry_count):
        if off + 2 > n:
            break
        peer_index = int.from_bytes(body[off:off + 2], "big"); off += 2
        if addpath:
            off += 4
        off += 4  # originated_time
        if off + 2 > n:
            break
        attrlen = int.from_bytes(body[off:off + 2], "big"); off += 2
        attrs = body[off:off + attrlen]; off += attrlen
        asns = _parse_attrs_aspath(attrs)
        entries.append((peer_index, asns))
    return plen, pfx_bytes, entries


def iter_focus_prefixes(
    path: str,
    focus_asns: list[int],
    keep_pred: Optional[Callable[[int, int, int], bool]] = None,
    limit: Optional[int] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
    global_mode: bool = False,
) -> Iterator[dict]:
    """流式解析 RIB, 产出前缀。

    global_mode=False: 仅产出 AS_PATH 含 focus_asns 任一的前缀(4 字节预筛加速)。
    global_mode=True : 产出**全部**前缀(全表), 不做 ASN 预筛/过滤(focus_asns 忽略)。
    无论哪种模式, keep_pred(start,end,family) 仍可进一步过滤(如只收 v4 / 某国家)。
    """
    focus = set(focus_asns)
    patterns = [a.to_bytes(4, "big") for a in focus]
    peers: list[tuple] = []
    scanned = 0
    kept = 0
    with gzip.open(path, "rb") as f:
      try:
        while True:
            hdr = _readn(f, 12)
            if len(hdr) < 12:
                break
            _, typ, subtype, length = _HDR.unpack(hdr)
            body = _readn(f, length)
            if len(body) < length:
                break
            if typ != MRT_TABLE_DUMP_V2:
                continue
            if subtype == ST_PEER_INDEX_TABLE:
                peers = _parse_peer_index(body)
                util.log(f"  peer_index: {len(peers)} 个 peer")
                continue
            if subtype not in (ST_RIB_IPV4_UNICAST, ST_RIB_IPV6_UNICAST,
                               ST_RIB_IPV4_UNICAST_ADDPATH, ST_RIB_IPV6_UNICAST_ADDPATH):
                continue
            scanned += 1
            if on_progress and scanned % 200000 == 0:
                on_progress(scanned, kept)
            # 4 字节焦点模式前置过滤 (C 速度子串查找); global 模式不预筛、全收
            if not global_mode:
                hit = False
                for p in patterns:
                    if p in body:
                        hit = True
                        break
                if not hit:
                    continue
            family = 4 if subtype in (ST_RIB_IPV4_UNICAST, ST_RIB_IPV4_UNICAST_ADDPATH) else 6
            addpath = subtype in (ST_RIB_IPV4_UNICAST_ADDPATH, ST_RIB_IPV6_UNICAST_ADDPATH)
            # 先用前缀头字节算出网段, 把(国家/family)过滤提到完整解析之前 — 跳过非目标前缀的昂贵解析
            plen0 = body[4]
            # 跳过默认路由(0.0.0.0/0 / ::/0): 它不代表任何具体网络的可达性, 入库只会污染搜索/统计。
            if plen0 == 0:
                continue
            nb0 = (plen0 + 7) // 8
            start, end, cidr = util.prefix_from_bytes(body[5:5 + nb0], plen0, family)
            if keep_pred and not keep_pred(start, end, family):
                continue
            plen, pfx_bytes, entries = _parse_rib_body(body, addpath)
            asnset: set[int] = set()
            for _pi, asns in entries:
                asnset.update(asns)
            if not global_mode and not (focus & asnset):
                continue
            paths = []
            origins: set[int] = set()
            for peer_index, asns in entries:
                if not asns:
                    continue
                pas, pip = peers[peer_index] if peer_index < len(peers) else (None, None)
                origins.add(asns[-1])
                paths.append({"peer_asn": pas, "peer_ip": pip, "asns": asns})
            kept += 1
            yield {
                "prefix": cidr, "start": start, "end": end, "family": family,
                "plen": plen, "origins": origins, "paths": paths,
            }
            if limit and kept >= limit:
                break
      except (EOFError, OSError) as e:
        # 截断/损坏的 gzip(如部分下载): 解析到此为止
        util.log(f"  解析在 EOF/截断处停止: {type(e).__name__}: {e}", err=True)
    if on_progress:
        on_progress(scanned, kept)


# ----------------------------------------------------------------------------
# 入库
# ----------------------------------------------------------------------------
def ingest(
    conn,
    cfg: dict,
    mrt_file: Optional[str] = None,
    url: Optional[str] = None,
    reset: bool = False,
    limit: Optional[int] = None,
    all_countries: bool = False,
    scope: Optional[str] = None,
) -> dict:
    util.ensure_dirs()
    db.init_schema(conn, migrate=True)   # ingest 才允许破坏性迁移 pathobs

    if mrt_file is None:
        if url is None:
            url = latest_bview_url(cfg)
            util.log(f"  最新 RIB: {url}")
        mrt_file = download(url)
        db.set_meta(conn, "mrt_url", url)
    db.set_meta(conn, "mrt_file", mrt_file)

    if reset:
        util.log("  --reset: 清空 prefix/pathobs/path_asn")
        for t in ("prefix", "pathobs", "path_asn"):
            conn.execute(f"DELETE FROM {t}")
        conn.commit()

    scope = scope or cfg.get("ingest_scope", "global")
    global_mode = (scope == "global")

    has_geo = db.table_count(conn, "geo") > 0
    cc = cfg.get("focus_country_code")
    if not has_geo:
        util.log("  ! geo 表为空, 跳过地理标注 (建议先 `ipc geo-import`)", err=True)
    # global: 收全部 v4(不按 ASN/国家); focus: 旧口径(境内 ∩ focus_asns)。
    do_country_filter = (not global_mode) and has_geo and cc and not all_countries

    gindex = geoip.GeoIndex(conn) if has_geo else None

    # 入库口径见 GLOBAL_DESIGN.md: global=全表 v4(城市在展示时由 ipdb 切段); focus=境内含焦点 ASN。
    def keep_pred(start: int, end: int, family: int) -> bool:
        if global_mode:
            return family == 4          # 全表(v4); v6 deferred(SQLite INTEGER 装不下 128 位)
        if not has_geo or not do_country_filter:
            return True
        return gindex.country_of(start) == cc

    focus = [] if global_mode else bgp.resolve_asns(cfg["focus_asns"])
    util.log(f"  scope={scope}; 焦点ASN={'(全表)' if global_mode else focus}; "
             f"国家过滤={cc if do_country_filter else '关闭'}; "
             f"v6={'跳过' if global_mode else 'n/a'}; 城市过滤=关闭(展示时按 ipdb 切段)")

    t0 = time.time()

    def progress(scanned: int, kept: int):
        rate = scanned / max(time.time() - t0, 1e-6)
        util.log(f"  扫描 {util.human(scanned)} 前缀, 命中 {kept} ({util.human(rate)}/s)")

    ins_prefix = (
        "INSERT INTO prefix(prefix,start_num,end_num,family,plen,origin_asn,n_origins,"
        "country_code,province,city,isp,geo_isp,n_paths,ingest_ts) "
        "VALUES(:prefix,:start,:end,:family,:plen,:origin,:n_origins,:cc,:prov,:city,:isp,"
        ":geo_isp,:np,:ts) "
        "ON CONFLICT(prefix) DO UPDATE SET start_num=excluded.start_num,end_num=excluded.end_num,"
        "origin_asn=excluded.origin_asn,n_origins=excluded.n_origins,country_code=excluded.country_code,"
        "province=excluded.province,city=excluded.city,geo_isp=excluded.geo_isp,"
        "n_paths=excluded.n_paths,ingest_ts=excluded.ingest_ts"
    )
    now = int(time.time())
    n_prefix = n_path = 0
    batch = 0

    for rec in iter_focus_prefixes(mrt_file, focus, keep_pred=keep_pred,
                                   limit=limit, on_progress=progress,
                                   global_mode=global_mode):
        geo = gindex.tag(rec["start"]) if gindex else {
            "country_code": None, "province": None, "city": None, "geo_isp": None}

        # 去重路径: 同前缀同一 clean path 合并, 累加观测它的 peer 数(n_peers)。
        dedup: dict[str, dict] = {}
        all_asns: set[int] = set()
        for p in rec["paths"]:
            clean = bgp.clean_path(p["asns"])
            if not clean:
                continue
            key = " ".join(map(str, clean))
            d = dedup.get(key)
            if d is None:
                dedup[key] = {"clean": key, "len": len(clean), "origin": clean[-1], "n": 1}
            else:
                d["n"] += 1
            if not global_mode:
                all_asns.update(p["asns"])
        origin = max(set(rec["origins"]), key=lambda a: sum(1 for p in rec["paths"] if p["asns"] and p["asns"][-1] == a)) if rec["origins"] else None

        conn.execute(ins_prefix, {
            "prefix": rec["prefix"], "start": rec["start"], "end": rec["end"],
            "family": rec["family"], "plen": rec["plen"], "origin": origin,
            "n_origins": len(rec["origins"]), "cc": geo["country_code"],
            "prov": geo["province"], "city": geo["city"], "isp": None,
            "geo_isp": geo["geo_isp"], "np": len(rec["paths"]), "ts": now,
        })
        pid_row = conn.execute("SELECT id FROM prefix WHERE prefix=?", (rec["prefix"],)).fetchone()
        pid = pid_row["id"]

        # pathobs (去重后, 先删旧)
        conn.execute("DELETE FROM pathobs WHERE prefix_id=?", (pid,))
        conn.executemany(
            "INSERT INTO pathobs(prefix_id,path_clean,path_len,origin_asn,n_peers) "
            "VALUES(?,?,?,?,?)",
            [(pid, d["clean"], d["len"], d["origin"], d["n"]) for d in dedup.values()],
        )
        # path_asn 倒排 (仅 focus 模式; global 全表会爆, 前端/DuckDB 直接查 path 串)
        if not global_mode:
            conn.execute("DELETE FROM path_asn WHERE prefix_id=?", (pid,))
            conn.executemany(
                "INSERT OR IGNORE INTO path_asn(prefix_id,asn,is_origin) VALUES(?,?,?)",
                [(pid, a, 1 if a == origin else 0) for a in all_asns],
            )

        n_prefix += 1
        n_path += len(dedup)
        batch += 1
        if batch >= 500:
            conn.commit()
            batch = 0

    conn.commit()
    db.set_meta(conn, "ingest_ts", now)
    db.set_meta(conn, "ingest_scope", scope)
    util.log(f"  入库完成: {n_prefix} 前缀, {n_path} 条去重路径")
    conn.execute("ANALYZE")
    conn.commit()
    return {"prefixes": n_prefix, "pathobs": n_path, "scope": scope}
