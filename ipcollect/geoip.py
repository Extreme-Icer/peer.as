"""GeoIP: 把 ipdb.txt 导入 sqlite, 并提供按 IP 查地理/运营商。

ipdb.txt 格式 (| 分隔, 首行表头):
    start_ip|end_ip|start_ip_num|end_ip_num|continent|country|province|city|
    district|isp|area_code|country_english|country_code|longitude|latitude
"""
from __future__ import annotations

import sqlite3
from bisect import bisect_right
from typing import Optional

from . import util


def _f(x: str) -> Optional[float]:
    x = x.strip()
    if not x:
        return None
    try:
        return float(x)
    except ValueError:
        return None


def import_ipdb(conn: sqlite3.Connection, path: str, batch: int = 50000) -> int:
    """导入(全量覆盖)。返回导入行数。"""
    conn.execute("DELETE FROM geo")
    conn.commit()
    n = 0
    rows: list[tuple] = []
    insert = (
        "INSERT INTO geo(start_num,end_num,country,country_code,province,city,"
        "district,isp,lon,lat) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        header = f.readline()  # 跳过表头
        if not header.startswith("start_ip"):
            # 不是预期表头, 当作数据行回退处理
            f.seek(0)
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 13:
                continue
            try:
                s = int(parts[2]); e = int(parts[3])
            except ValueError:
                continue
            rows.append((
                s, e,
                parts[5] or None,          # country
                parts[12] or None,         # country_code
                parts[6] or None,          # province
                parts[7] or None,          # city
                parts[8] or None,          # district
                parts[9] or None,          # isp
                _f(parts[13]) if len(parts) > 13 else None,
                _f(parts[14]) if len(parts) > 14 else None,
            ))
            if len(rows) >= batch:
                conn.executemany(insert, rows)
                n += len(rows)
                rows.clear()
                if n % 200000 == 0:
                    util.log(f"  geo 导入 {util.human(n)} 行 ...")
        if rows:
            conn.executemany(insert, rows)
            n += len(rows)
    conn.commit()
    util.log(f"  geo 导入完成: {n} 行, 建索引 ...")
    conn.execute("ANALYZE geo")
    conn.commit()
    return n


# ----------------------------------------------------------------------------
# geo provider: RIR delegated-extended (国家级, 完全开放可再分发) —— OSS 复现用
# (官方部署用私有 ipdb 出城市级; 见 docs/GLOBAL_DESIGN.md geo 双轨)
# ----------------------------------------------------------------------------
RIR_URLS = [
    "https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest",
    "https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
    "https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest",
    "https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest",
    "https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest",
]


def import_rir(conn: sqlite3.Connection, urls: Optional[list] = None) -> int:
    """从 5 大 RIR 的 delegated-extended 统计导入**国家级** IPv4 范围(country_code, 无城市)。
    完全开放、可随仓库再分发, 让无 ipdb 的环境也能复现(仅国家级)。返回导入行数。"""
    import ipaddress as _ip
    import requests
    conn.execute("DELETE FROM geo"); conn.commit()
    insert = ("INSERT INTO geo(start_num,end_num,country,country_code,province,city,"
              "district,isp,lon,lat) VALUES(?,?,?,?,?,?,?,?,?,?)")
    n = 0; rows: list[tuple] = []
    for url in (urls or RIR_URLS):
        util.log(f"  RIR: 下载 {url}")
        text = requests.get(url, timeout=180).text
        for line in text.splitlines():
            if not line or line[0] == "#":
                continue
            p = line.split("|")
            if len(p) < 7 or p[2] != "ipv4" or not p[1] or p[3] == "*":
                continue
            if p[6] not in ("allocated", "assigned"):
                continue
            try:
                start = int(_ip.IPv4Address(p[3])); cnt = int(p[4])
            except (ValueError, _ip.AddressValueError):
                continue
            rows.append((start, start + cnt - 1, None, p[1], None, None, None, None, None, None))
            if len(rows) >= 50000:
                conn.executemany(insert, rows); n += len(rows); rows.clear()
    if rows:
        conn.executemany(insert, rows); n += len(rows)
    conn.commit()
    util.log(f"  RIR 导入完成: {n} 段(国家级), 建索引...")
    conn.execute("ANALYZE geo"); conn.commit()
    return n


def lookup_int(conn: sqlite3.Connection, ip_num: int) -> Optional[sqlite3.Row]:
    row = conn.execute(
        "SELECT * FROM geo WHERE start_num<=? ORDER BY start_num DESC LIMIT 1",
        (ip_num,),
    ).fetchone()
    if row and row["end_num"] >= ip_num:
        return row
    return None


def lookup(conn: sqlite3.Connection, ip: str) -> Optional[sqlite3.Row]:
    return lookup_int(conn, util.ip2int(ip))


class GeoIndex:
    """把 geo 表一次性载入内存 (列式 + bisect 二分), 供 ingest 高频查询。

    每次查询 ~1µs (C 级 bisect), 取代每前缀一次 SQL 往返 — 全量 ingest 提速 ~50x。
    """

    def __init__(self, conn: sqlite3.Connection):
        import sys as _sys
        rows = conn.execute(
            "SELECT start_num,end_num,country_code,province,city,isp "
            "FROM geo ORDER BY start_num"
        ).fetchall()
        self.starts: list[int] = [r[0] for r in rows]
        self.ends: list[int] = [r[1] for r in rows]
        intern = _sys.intern
        self.cc = [intern(r[2]) if r[2] else None for r in rows]
        self.prov = [intern(r[3]) if r[3] else None for r in rows]
        self.city = [intern(r[4]) if r[4] else None for r in rows]
        self.isp = [intern(r[5]) if r[5] else None for r in rows]
        util.log(f"  GeoIndex: 载入 {len(self.starts)} 段到内存")

    def _idx(self, ipnum: int) -> int:
        i = bisect_right(self.starts, ipnum) - 1
        if i >= 0 and self.ends[i] >= ipnum:
            return i
        return -1

    def country_of(self, ipnum: int) -> Optional[str]:
        i = self._idx(ipnum)
        return self.cc[i] if i >= 0 else None

    def tag(self, ipnum: int) -> dict:
        i = self._idx(ipnum)
        if i < 0:
            return {"country_code": None, "province": None, "city": None, "geo_isp": None}
        return {"country_code": self.cc[i], "province": self.prov[i],
                "city": self.city[i], "geo_isp": self.isp[i]}

    def carve(self, start: int, end: int, city_set: set | None = None) -> list[tuple]:
        """把 [start,end] 按 ipdb 切成各城市片段 (裁剪到该前缀内)。

        city_set=None: 收所有有城市名的子段(以 ipdb 为准、把跨城大段拆成各城市子段);
        给定集合则只收该集合内城市。返回 [(cstart, cend, city, province), ...] 按地址升序。
        """
        out = []
        i = bisect_right(self.starts, end) - 1   # 最后一个 start<=end 的段
        while i >= 0 and self.ends[i] >= start:   # 仍与 [start,end] 相交
            city = self.city[i]
            if city and (city_set is None or city in city_set):
                out.append((max(start, self.starts[i]), min(end, self.ends[i]), city, self.prov[i]))
            i -= 1
        out.reverse()
        return out

    def carve_cc(self, start: int, end: int) -> list[tuple]:
        """把 [start,end] 按 ipdb 切成各子段, 带国家/省/市 (裁剪到该前缀内)。

        与 carve 不同: **不过滤 city**, 收所有有 country_code 的子段(country-level 也要)。
        返回 [(cstart, cend, cc, province, city), ...] 按地址升序。供全球分层 carve(Parquet)。
        """
        out = []
        i = bisect_right(self.starts, end) - 1
        while i >= 0 and self.ends[i] >= start:
            cc = self.cc[i]
            if cc:
                out.append((max(start, self.starts[i]), min(end, self.ends[i]),
                            cc, self.prov[i], self.city[i]))
            i -= 1
        out.reverse()
        return out


def focus_intervals(conn: sqlite3.Connection, city_set, prov_set) -> tuple[list, list]:
    """焦点城市/省的 ipdb 区间, 合并相邻后按 start 升序返回 (starts, ends)。供范围相交判定。"""
    if not (city_set or prov_set):
        return [], []
    conds, params = [], []
    if city_set:
        conds.append(f"city IN ({','.join('?' * len(city_set))})"); params += list(city_set)
    if prov_set:
        conds.append(f"province IN ({','.join('?' * len(prov_set))})"); params += list(prov_set)
    rows = conn.execute(
        f"SELECT start_num,end_num FROM geo WHERE {' OR '.join(conds)} ORDER BY start_num", params)
    starts: list[int] = []
    ends: list[int] = []
    for s, e in rows:
        if ends and s <= ends[-1] + 1:        # 合并相邻/重叠
            if e > ends[-1]:
                ends[-1] = e
        else:
            starts.append(s); ends.append(e)
    return starts, ends


def interval_overlap(starts: list, ends: list, s: int, e: int) -> bool:
    """[s,e] 是否与合并区间 (starts,ends) 中任一相交。O(log n)。"""
    if not starts:
        return False
    i = bisect_right(starts, e) - 1
    return i >= 0 and ends[i] >= s


def tag_for_prefix(conn: sqlite3.Connection, start_num: int) -> dict:
    """给前缀打地理标签 (用网络地址查)。返回 dict 便于写入 prefix 表。"""
    row = lookup_int(conn, start_num)
    if not row:
        return {"country_code": None, "province": None, "city": None, "geo_isp": None}
    return {
        "country_code": row["country_code"],
        "province": row["province"],
        "city": row["city"],
        "geo_isp": row["isp"],
    }
