"""查询 / 展示 / 导出 / 统计 / 路由 insight。"""
from __future__ import annotations

import csv
import io
import json
import sys
from typing import Optional

from . import bgp, db, util


def _path_seq_clause(path_seq):
    """path 连续子序列过滤: 返回 (where 片段, 参数) 或 (None, None)。

    匹配在去重后的 path_clean 上做带空格边界的子串匹配, 保证顺序+相邻+整词。
    """
    seq = bgp.resolve_asns(path_seq or [])
    if not seq:
        return None, None
    pattern = "% " + " ".join(str(a) for a in seq) + " %"
    clause = "p.id IN (SELECT prefix_id FROM pathobs WHERE (' '||path_clean||' ') LIKE ?)"
    return clause, pattern


# ----------------------------------------------------------------------------
# 主筛选: 前缀级 (城市 + path含ASN/顺序 + origin ...)
# ----------------------------------------------------------------------------
def query_prefixes(conn, cities=None, provinces=None, path_asns=None, path_seq=None,
                   origin_asn=None, family=4, limit=200):
    where = ["p.family=?"]
    params: list = [family]
    if cities:
        where.append(f"p.city IN ({','.join('?'*len(cities))})"); params += cities
    if provinces:
        where.append(f"p.province IN ({','.join('?'*len(provinces))})"); params += provinces
    if path_asns:
        # 含任一 ASN(无序): 对去重 path 串做 OR LIKE(global 无 path_asn 倒排, 两种模式都用这条)
        likes = " OR ".join("(' '||path_clean||' ') LIKE ?" for _ in path_asns)
        where.append(f"p.id IN (SELECT prefix_id FROM pathobs WHERE {likes})")
        params += [f"% {a} %" for a in path_asns]
    pc, pp = _path_seq_clause(path_seq)
    if pc:
        where.append(pc); params.append(pp)
    if origin_asn is not None:
        where.append("p.origin_asn=?"); params.append(origin_asn)
    sql = (
        "SELECT p.prefix,p.city,p.province,p.origin_asn,p.n_paths "
        "FROM prefix p WHERE " + " AND ".join(where) +
        " ORDER BY p.n_paths DESC LIMIT ?"
    )
    params.append(int(limit))
    return conn.execute(sql, params).fetchall()


# ----------------------------------------------------------------------------
# Insight: 某前缀/IP 的 multihome 等价路由
# ----------------------------------------------------------------------------
def resolve_prefix(conn, target: str):
    target = target.strip()
    if "/" in target:
        row = conn.execute("SELECT * FROM prefix WHERE prefix=?", (target,)).fetchone()
        if row:
            return row
        target = target.split("/")[0]
    try:
        ipnum = util.ip2int(target)
    except ValueError:
        return None
    return conn.execute(
        "SELECT * FROM prefix WHERE start_num<=? AND end_num>=? "
        "ORDER BY (end_num-start_num) ASC LIMIT 1", (ipnum, ipnum),
    ).fetchone()


def insight(conn, target: str) -> Optional[dict]:
    p = resolve_prefix(conn, target)
    if not p:
        return None
    # pathobs 已是去重路径 + n_peers, 直接读(短路径/多 peer 在前)。
    rows = conn.execute(
        "SELECT path_clean,path_len,n_peers FROM pathobs WHERE prefix_id=? "
        "ORDER BY path_len ASC, n_peers DESC", (p["id"],),
    ).fetchall()
    groups = [{
        "path": r["path_clean"],
        "path_asns": [int(x) for x in r["path_clean"].split()] if r["path_clean"] else [],
        "path_len": r["path_len"], "n_peers": r["n_peers"],
    } for r in rows]
    total_peers = sum(r["n_peers"] for r in rows)
    return {
        "prefix": p["prefix"], "city": p["city"], "province": p["province"],
        "origin_asn": p["origin_asn"], "origin_name": bgp.asn_name(p["origin_asn"] or 0),
        "n_peers": total_peers, "n_distinct_paths": len(groups),
        "paths": groups,
    }


# ----------------------------------------------------------------------------
# 统计
# ----------------------------------------------------------------------------
def stats(conn, cfg) -> dict:
    s: dict = {}
    s["prefixes"] = db.table_count(conn, "prefix")
    s["pathobs"] = db.table_count(conn, "pathobs")
    s["geo_rows"] = db.table_count(conn, "geo")
    s["top_cities"] = [
        (r["city"], r["c"]) for r in conn.execute(
            "SELECT city, COUNT(*) c FROM prefix WHERE city IS NOT NULL "
            "GROUP BY city ORDER BY c DESC LIMIT 15")
    ]
    s["mrt_url"] = db.get_meta(conn, "mrt_url")
    s["ingest_ts"] = db.get_meta(conn, "ingest_ts")
    return s


# ----------------------------------------------------------------------------
# 导出 / 打印
# ----------------------------------------------------------------------------
def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


def export(rows, fmt: str = "table", out=None) -> str:
    dicts = rows_to_dicts(rows)
    if fmt == "json":
        text = json.dumps(dicts, ensure_ascii=False, indent=2)
    elif fmt == "csv":
        if not dicts:
            text = ""
        else:
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=list(dicts[0].keys()))
            w.writeheader(); w.writerows(dicts)
            text = buf.getvalue()
    else:
        text = render_table(dicts)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        return f"已写出 {len(dicts)} 行 -> {out}"
    return text


def render_table(dicts: list[dict]) -> str:
    if not dicts:
        return "(无结果)"
    cols = list(dicts[0].keys())
    widths = {c: len(c) for c in cols}
    svals = []
    for d in dicts:
        row = {}
        for c in cols:
            v = d.get(c)
            sv = "" if v is None else (f"{v:.1f}" if isinstance(v, float) else str(v))
            row[c] = sv
            widths[c] = max(widths[c], len(sv))
        svals.append(row)
    widths = {c: min(w, 40) for c, w in widths.items()}
    line = "  ".join(c.ljust(widths[c]) for c in cols)
    out = [line, "  ".join("-" * widths[c] for c in cols)]
    for row in svals:
        out.append("  ".join(row[c][:widths[c]].ljust(widths[c]) for c in cols))
    return "\n".join(out)


def print_insight(ins: dict) -> None:
    if not ins:
        print("未找到该前缀/IP (可能未在焦点集中)。")
        return
    print(f"前缀 {ins['prefix']}  地区: {ins['province'] or ''}{ins['city'] or ''}  "
          f"origin asn: {ins['origin_asn']}({ins['origin_name']})")
    print(f"观测 peer {ins['n_peers']} 个, 去重路径 {ins['n_distinct_paths']} 条\n")
    print(f"{'#peer':>5}  {'len':>3}  路径 (AS_PATH, 以目标为终点的去程)")
    print("-" * 80)
    for g in ins["paths"]:
        path_str = bgp.fmt_path(g["path_asns"])
        print(f"{g['n_peers']:>5}  {g['path_len']:>3}  {path_str}")


def print_stats(s: dict) -> None:
    print(f"前缀:        {s['prefixes']:>8}   path观测: {s['pathobs']:>10}")
    print(f"geo行:       {s['geo_rows']:>8}")
    print(f"MRT:         {s.get('mrt_url')}")
    print(f"前缀最多城市: {s['top_cities']}")
