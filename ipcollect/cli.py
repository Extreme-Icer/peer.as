"""命令行入口: ipc <子命令>。"""
from __future__ import annotations

import argparse
import sys

from . import bgp, build, config, db, geoip, mrt, report, serve, util


def _conn():
    util.ensure_dirs()
    conn = db.connect()
    db.init_schema(conn)
    return conn


def _csv_list(s):
    return [x.strip() for x in s.split(",") if x.strip()] if s else None


def _int_list(s):
    return [int(x) for x in _csv_list(s) or []] or None


def _seq_list(s):
    """解析 path 序列: 逗号/空格/箭头分隔均可, 如 '23764 4809' 或 '23764,4809' 或 '23764->4809'。"""
    if not s:
        return None
    s = s.replace("->", " ").replace(",", " ")
    return [int(x) for x in s.split() if x.strip().isdigit()] or None


# ----------------------------------------------------------------------------
# 子命令实现
# ----------------------------------------------------------------------------
def cmd_init(args):
    wrote = config.init_default(force=args.force)
    util.ensure_dirs()
    conn = _conn()
    util.log(f"配置: {util.CONFIG_PATH} ({'已写默认' if wrote else '已存在, 保留'})")
    util.log(f"数据库: {util.DB_PATH}")
    if args.geo_import:
        cfg = config.load()
        n = geoip.import_ipdb(conn, cfg["ipdb_path"])
        util.log(f"geo 导入 {n} 行")
    print("初始化完成。下一步: ipc geo-import  然后  ipc ingest")


def cmd_config(args):
    cfg = config.load()
    if args.action == "show" or args.action is None:
        import json
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
        return
    if args.action == "set":
        key, val = args.key, args.value
        if key in ("focus_asns",):
            # 纯 ASN 列表 (path 含这些 ASN 即入库, 无质量含义)
            cfg[key] = bgp.resolve_asns(_csv_list(val) or [])
        elif key in ("focus_cities", "focus_provinces"):
            cfg[key] = _csv_list(val) or []
        else:
            cfg[key] = val
        config.save(cfg)
        print(f"已设置 {key} = {cfg[key]}")


def cmd_geo_import(args):
    cfg = config.load()
    conn = _conn()
    provider = args.provider or cfg.get("geo_provider", "ipdb")
    if provider == "rir":
        util.log("导入 RIR delegated-extended (国家级开放库)")
        n = geoip.import_rir(conn)
    else:
        path = args.path or cfg["ipdb_path"]
        util.log(f"导入 ipdb: {path}")
        n = geoip.import_ipdb(conn, path)
    print(f"geo 导入完成 ({provider}): {n} 行")


def cmd_geo_lookup(args):
    conn = _conn()
    row = geoip.lookup(conn, args.ip)
    if not row:
        print("未找到"); return
    print(dict(row))


def cmd_ingest(args):
    cfg = config.load()
    conn = _conn()
    r = mrt.ingest(conn, cfg, mrt_file=args.mrt_file, url=args.url,
                   reset=args.reset, limit=args.limit, all_countries=args.all_countries,
                   scope=args.scope)
    print(f"ingest 完成: {r}")


def cmd_query(args):
    cfg = config.load()
    conn = _conn()
    rows = report.query_prefixes(
        conn,
        cities=_csv_list(args.city),
        provinces=_csv_list(args.province),
        path_asns=_int_list(args.asn),
        path_seq=_seq_list(args.path),
        origin_asn=args.origin,
        limit=args.limit)
    out = report.export(rows, fmt=args.format, out=args.out)
    print(out)
    if args.format == "table" and not args.out:
        print(f"\n共 {len(rows)} 个前缀")


def cmd_insight(args):
    conn = _conn()
    report.print_insight(report.insight(conn, args.target))


def cmd_stats(args):
    cfg = config.load()
    conn = _conn()
    report.print_stats(report.stats(conn, cfg))


def cmd_build(args):
    """构建前端(Vite+Svelte: npm run build)并拷进 dist/。改了前端(web/)的日常命令;
    不碰数据(免重跑 export-parquet)。--no-npm 跳过 npm、只拷已构建的 web/dist。"""
    from pathlib import Path
    from . import parquet_export
    web = Path(__file__).resolve().parent / "web"
    if not args.no_npm:
        import subprocess
        util.log("npm run build (ipcollect/web) …")
        subprocess.run(["npm", "run", "build"], cwd=str(web), check=True)
    n = parquet_export.copy_web(out_dir=args.out)
    print(f"前端构建完成: npm run build + 拷 {n} 文件 (web/dist -> {args.out}/); 数据未动。")
    print(f"部署: wrangler pages deploy {args.out} --project-name bgp-insights "
          f"--branch main --commit-dirty=true --commit-message=\"...\"")


def cmd_export_parquet(args):
    cfg = config.load()
    conn = _conn()
    from . import parquet_export
    r = parquet_export.export(cfg, conn, str(util.DB_PATH), out_dir=args.out)
    print(f"parquet 导出: {r['parquet_files']} 文件 / {util.human(r['parquet_bytes'])}B "
          f"({r['prefixes']} 前缀, {r['paths']} 去重路径, {r['segments']} 切段, "
          f"{r['countries']} 国家, dfz_ref={r['dfz_ref']}) -> {r['out']}/data/parquet/")


def cmd_sync_web(args):
    """只把已构建前端 web/dist 拷进 out(数据没变、web 已 build 时用; 要顺带 npm build 用 `ipc build`)。"""
    from . import parquet_export
    n = parquet_export.copy_web(out_dir=args.out)
    print(f"前端已同步: {n} 文件 (web/dist -> {args.out}/); 未跑 npm、未重导出 parquet/SSG。")


def cmd_serve(args):
    cfg = config.load()
    serve.serve(cfg, out_dir=args.out, port=args.port, host=args.host, rebuild=args.rebuild)


# ----------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(prog="ipc", description="BGP Insights — 回程 AS_PATH 采集/分析/静态看板")
    p.add_argument("-q", "--quiet", action="store_true", help="减少日志")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("init", help="初始化配置与数据库")
    s.add_argument("--force", action="store_true", help="覆盖已有配置")
    s.add_argument("--geo-import", action="store_true", help="顺带导入 ipdb")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("config", help="查看/修改配置")
    cs = s.add_subparsers(dest="action")
    cs.add_parser("show").set_defaults(func=cmd_config)
    st = cs.add_parser("set"); st.add_argument("key"); st.add_argument("value")
    st.set_defaults(func=cmd_config)
    s.set_defaults(func=cmd_config)

    s = sub.add_parser("geo-import", help="导入地理库(ipdb 城市级 / rir 国家级开放)")
    s.add_argument("--path", help="ipdb 路径(默认取配置)")
    s.add_argument("--provider", choices=["ipdb", "rir"], help="地理库来源(默认取配置 geo_provider)")
    s.set_defaults(func=cmd_geo_import)

    s = sub.add_parser("geo-lookup", help="查单个 IP 的地理/运营商")
    s.add_argument("ip"); s.set_defaults(func=cmd_geo_lookup)

    s = sub.add_parser("ingest", help="下载并解析 rrc00 RIB 入库(global=全表 v4 / focus=境内含焦点ASN)")
    s.add_argument("--reset", action="store_true", help="清空旧前缀数据重建")
    s.add_argument("--limit", type=int, help="最多入库前缀数(调试)")
    s.add_argument("--mrt-file", help="用本地 MRT 文件而非下载")
    s.add_argument("--url", help="指定 RIB URL")
    s.add_argument("--all-countries", action="store_true", help="(focus模式)不按国家过滤")
    s.add_argument("--scope", choices=["global", "focus"], help="入库范围(默认取配置 ingest_scope)")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("query", help="按 城市 + path(含ASN/顺序) + origin 筛选前缀")
    s.add_argument("--city"); s.add_argument("--province")
    s.add_argument("--asn", help="path 含任一ASN(逗号分隔, 无序)")
    s.add_argument("--path", help="path 含此连续序列(如 '23764 4809', 有序相邻)")
    s.add_argument("--origin", type=int, help="origin asn")
    s.add_argument("--limit", type=int, default=200)
    s.add_argument("--format", choices=["table", "json", "csv"], default="table")
    s.add_argument("--out", help="写入文件")
    s.set_defaults(func=cmd_query)

    s = sub.add_parser("insight", help="某前缀/IP 的 multihome 等价路由")
    s.add_argument("target"); s.set_defaults(func=cmd_insight)

    s = sub.add_parser("stats", help="数据库统计")
    s.set_defaults(func=cmd_stats)

    s = sub.add_parser("build", help="构建前端(npm run build)并拷进 dist/(改了前端日常用; 不碰数据)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.add_argument("--no-npm", action="store_true", help="跳过 npm run build, 只拷已构建的 web/dist(同 sync-web)")
    s.set_defaults(func=cmd_build)

    s = sub.add_parser("export-parquet", help="导出 Parquet 数据集(全球, 供 DuckDB-WASM 前端)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.set_defaults(func=cmd_export_parquet)

    s = sub.add_parser("sync-web", help="只拷已构建前端 web/dist -> dist(不跑 npm; 要顺带 build 用 `ipc build`)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.set_defaults(func=cmd_sync_web)

    s = sub.add_parser("serve", help="本地 debug: 静态托管 build 产物")
    s.add_argument("--out", default="dist", help="要托管的目录(默认 dist)")
    s.add_argument("--rebuild", action="store_true", help="先重新 build 再托管")
    s.add_argument("--host", default="127.0.0.1"); s.add_argument("--port", type=int, default=8787)
    s.set_defaults(func=cmd_serve)

    return p


def main(argv=None):
    p = build_parser()
    args = p.parse_args(argv)
    if args.quiet:
        util.set_quiet(True)
    if not getattr(args, "func", None):
        p.print_help(); return 1
    try:
        return args.func(args) or 0
    except KeyboardInterrupt:
        util.log("中断", err=True); return 130
    except Exception as e:  # noqa
        util.log(f"错误: {e}", err=True)
        if __debug__ and "--trace" in (argv or sys.argv):
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
