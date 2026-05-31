"""把 SQLite 库导出为 **Parquet 数据集**, 供 DuckDB-WASM 前端按 HTTP Range 查询(无后端)。

产出 (默认 dist/data/):
  parquet/geo/<cc>/*.parquet   国家 working-set: 每 (pid,cc,city) 一行, 内嵌去重路径 paths_blob/
                               best_path + 本段范围 segs(list<struct s,e>) + prefix。**每目录单一 cc**,
                               选国家直接读该目录(无跨国扫描)。文件按 16MB / ROW_GROUP_SIZE 15000 切。
  parquet/prefixes/*.parquet   全部 v4 前缀, **按 ip_start 排序**(子网搜索/父子段范围/pid 详情)。即 ipindex。
  parquet/paths/*.parquet      每前缀去重 AS_PATH(<=PATH_CAP), **按 pid 排序**(insight 抽屉全量路径)。
  parquet/pathsearch/*.parquet **全表一行/前缀**(paths_blob+origin_asn+cc): 不选国家时的全局 path/origin 搜索。
  parquet/asn_dim.parquet      ASN -> name/op。
  meta.json                    dfz_ref + counts + countries(从 geo_full) + country_names(zh/en) +
                               focus_countries + cities + presets + focus_asns + asn_names/ops + site_base。
另: ssg.generate 产出 c/<cc>.html(双语 SEO 落地页) + countries.html + sitemap.xml + robots.txt。

排序/分目录是性能命门: geo 按 cc 分目录、prefixes 按 ip_start、paths 按 pid —— DuckDB-WASM 才能用
parquet row-group 的 min/max 做 Range 行级裁剪(只拉命中字节)。/tmp 多为 tmpfs(RAM), duckdb 溢出目录
必须落真盘(见 _duck), 否则全表聚合 OOM。契约见 docs/GLOBAL_DESIGN.md。仅依赖 duckdb(python)。
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from . import build as _build  # 复用 _forest / _subtract
from . import bgp, geoip, util

PATH_CAP = 24       # 每前缀最多导出多少条去重 path(短路径优先)
FILE_SIZE = "16MB"  # 单 parquet 文件体积上限(留足余量 < CF Pages 25MiB/文件; duckdb 按 row-group 会略超)
# pathsearch 单独切更小: 它**按 origin_asn 排序**, 配合 meta.files.pathsearch_origin 区间索引,
# 一次 origin AS 搜索只读覆盖该 ASN 的那 1 个文件 -> 文件越小, 该次搜索下载越少(尤其 *.pages.dev 无 Range 时整文件下)。
PATHSEARCH_FILE_SIZE = "6MB"


def _duck():
    import os
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL sqlite; LOAD sqlite;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
    con.execute(f"PRAGMA memory_limit='{os.environ.get('IPC_DUCKDB_MEM', '16GB')}';")
    con.execute("SET preserve_insertion_order=false;")
    # **关键**: 溢出目录必须落在真盘 —— /tmp 多为 tmpfs(RAM), 往那溢出=占内存=照样 OOM。
    # 用项目 cache/(本例在 nvme, 800G 空闲)。CI 可用 IPC_DUCKDB_TMP 覆盖到工作区磁盘。
    tmp = os.environ.get("IPC_DUCKDB_TMP") or str(util.CACHE_DIR / "duck_tmp")
    os.makedirs(tmp, exist_ok=True)
    con.execute(f"SET temp_directory='{tmp}';")
    con.execute("SET max_temp_directory_size='200GB';")
    return con


def _focus_countries(cfg: dict) -> set[str]:
    """哪些国家下钻到**城市级**(其余只到国家级)。默认 CN + 配置 focus_geo_countries。"""
    s = {"CN"}
    s.update(cfg.get("focus_geo_countries") or [])
    return s


def _autnums(url: str) -> dict[int, str]:
    """下载 + 解析 APNIC autnums(`<asn> <HANDLE> - <Org>, <CC>`), 取 handle 作 ASN 名。
    缓存到 cache/autnums.txt 复用。失败返回空(降级到 config 注册表)。"""
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
        full = p[1].rsplit(",", 1)[0].strip()       # 去掉结尾 ", CC"
        handle = full.split(" - ", 1)[0].strip()    # 取 handle(AS-NAME)
        if handle:
            out[int(p[0])] = handle[:40]
    return out


def _ipdb_country_en(path: str) -> dict[str, str]:
    """扫 ipdb.txt 取 country_code -> country_english(英文国名), 供 SEO/i18n。
    列序: ...|country(5)|...|country_english(11)|country_code(12)|... 。"""
    out: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.readline()  # 表头
            for line in f:
                p = line.split("|")
                if len(p) > 12:
                    cc, en = p[12].strip(), p[11].strip()
                    if cc and en and cc not in out:
                        out[cc] = en
    except OSError:
        pass
    return out


# ----------------------------------------------------------------------------
# segments: 分层 geo carve (focus 国家城市级 / 其余国家级)
# ----------------------------------------------------------------------------
def _build_segments(conn, cfg) -> list[tuple]:
    """对每个 v4 前缀: 有效路由范围(自身 − 更具体子段) 按 ipdb 切段, 分层粒度。

    返回 [(pid, cc, province, city, ip_start, ip_end, plen, origin_asn, n_paths), ...]。
    focus 国家保留 city; 其余国家 city/province=None 并合并相邻同国段。
    """
    gindex = geoip.GeoIndex(conn)
    focus_cc = _focus_countries(cfg)
    items, parent, children = _build._forest(conn)
    info = {r["id"]: r for r in conn.execute(
        "SELECT id,origin_asn,n_paths,plen FROM prefix WHERE family=4")}
    out: list[tuple] = []
    done = 0
    for it in items:
        done += 1
        if done % 200000 == 0:
            util.log(f"  carve: {util.human(done)}/{util.human(len(items))} 前缀, {util.human(len(out))} 段")
        pid = it["id"]
        meta = info.get(pid)
        if not meta:
            continue
        holes = [(k["start"], k["end"]) for k in (children.get(pid) or [])]
        eff = _build._subtract(it["start"], it["end"], holes)  # 有效路由范围
        # 收集 (cc, city) -> 合并区间
        groups: dict[tuple, list] = {}
        prov_of: dict[tuple, str] = {}
        for es, ee in eff:
            for cs, ce, cc, prov, city in gindex.carve_cc(es, ee):
                citykey = city if cc in focus_cc else None
                provkey = prov if cc in focus_cc else None
                key = (cc, citykey)
                groups.setdefault(key, []).append((cs, ce))
                prov_of[key] = provkey
        for (cc, city), ivs in groups.items():
            # 合并相邻区间, 每个连续段一行
            for s, e in _merge(ivs):
                out.append((pid, cc, prov_of[(cc, city)], city, s, e,
                            meta["plen"], meta["origin_asn"], meta["n_paths"]))
    return out


def _merge(ivs: list) -> list[tuple]:
    out: list[list] = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


# ----------------------------------------------------------------------------
# 主导出
# ----------------------------------------------------------------------------
def export(cfg: dict, conn, sqlite_path: str, out_dir: str = "dist") -> dict:
    out = Path(out_dir)
    data = out / "data"
    pq = data / "parquet"
    if pq.exists():
        shutil.rmtree(pq)
    pq.mkdir(parents=True, exist_ok=True)

    # 1) 拷贝**已构建的** Svelte SPA (web/dist/, 由 `npm run build` 产出)。
    #    先清旧 assets/(hash 文件名会累积): 否则历史 bundle 残留膨胀。
    if (out / "assets").exists():
        shutil.rmtree(out / "assets")
    n_files = 0
    webdist = Path(__file__).resolve().parent / "web" / "dist"
    if webdist.exists():
        for p in webdist.rglob("*"):
            if p.is_file():
                dst = out / p.relative_to(webdist)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dst); n_files += 1
    else:
        util.log("  ! web/dist 不存在 —— 请先在 ipcollect/web 跑 `npm ci && npm run build`", err=True)

    con = _duck()
    con.execute(f"ATTACH '{sqlite_path}' AS s (TYPE sqlite, READ_ONLY);")

    # 2) prefixes: **按 ip_start 排序**(不分区) —— 同时服务子网搜索(ip_start 范围裁剪)与
    #    pid 详情点查(pid≈ip_start, 因 RIB 按前缀有序入库)。这张表即子网搜索的 ipindex。
    (pq / "prefixes").mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
          SELECT id AS pid, prefix, start_num AS ip_start, end_num AS ip_end,
                 plen, family, origin_asn, n_origins, n_paths,
                 COALESCE(country_code,'ZZ') AS cc, province, city
          FROM s.prefix WHERE family=4
          ORDER BY start_num
        ) TO '{pq}/prefixes' (FORMAT parquet,
              FILE_SIZE_BYTES '{FILE_SIZE}', OVERWRITE_OR_IGNORE);
    """)

    # 3) paths: 每前缀去重 path(<=PATH_CAP), 按 pid 排序, 文件按 ~20MB 切
    (pq / "paths").mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
          WITH p AS (
            SELECT prefix_id AS pid,
                   ' ' || path_clean || ' ' AS path_str,
                   list_transform(string_split(path_clean,' '), x -> TRY_CAST(x AS BIGINT)) AS path_arr,
                   path_len, n_peers,
                   row_number() OVER (PARTITION BY prefix_id
                       ORDER BY path_len ASC, n_peers DESC) AS rn
            FROM s.pathobs
          )
          SELECT pid, path_str, path_arr, path_len, n_peers, (rn=1) AS is_best
          FROM p WHERE rn <= {PATH_CAP}
          ORDER BY pid
        ) TO '{pq}/paths' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}', OVERWRITE_OR_IGNORE);
    """)

    # 4) ASN 名称表: APNIC autnums(handle) ∩ **数据里实际出现的 ASN**(origin + 路径里的) + 注册表覆盖。
    #    全量~46万太大(10MB), 只留出现过的(~10万)。写 data/asnames.json, 前端开机 fetch 一次建查找表。
    autnums = _autnums(cfg.get("autnums_url") or "https://thyme.apnic.net/current/data-used-autnums")
    seen: set[int] = set()
    if autnums:
        for r in con.execute(
                f"SELECT DISTINCT unnest(path_arr) a FROM read_parquet('{pq}/paths/*.parquet')").fetchall():
            if r[0] is not None:
                seen.add(int(r[0]))
        for r in con.execute(
                "SELECT DISTINCT origin_asn FROM s.prefix WHERE family=4 AND origin_asn IS NOT NULL").fetchall():
            seen.add(int(r[0]))
    asnames = {a: autnums[a] for a in seen if a in autnums}
    for e in (cfg.get("asn_registry") or []):           # 我们特别标注的优先, 且总是收录
        if str(e.get("asn", "")).isdigit() and e.get("name"):
            asnames[int(e["asn"])] = e["name"]
    (data / "asnames.json").write_text(
        json.dumps({str(k): v for k, v in asnames.items()}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    util.log(f"  asnames.json: {len(asnames)} 个 ASN 名(出现过的)")

    # 5) geo: **国家working-set表**(cc 分区)。一行=(pid, cc, city)，内嵌该前缀去重路径(供搜索/列表,
    #    in-browser 过滤, 无需再拉 paths)+ 本(城)段 CIDR 范围列表。前端选国家=只拉该 cc 分区。
    util.log("  geo: 全表 carve 切段中...")
    segs = _build_segments(conn, cfg)   # [(pid,cc,prov,city,ip_start,ip_end,plen,origin,n_paths)]
    # 经 CSV 灌入 duckdb (executemany 对 ~1.3M 行慢 ~100x; CSV 往返秒级)。空串=NULL(province/city 可空)。
    import csv as _csv
    import os as _os
    import tempfile as _tf
    seg_csv = _os.path.join(_tf.gettempdir(), f"ipc_seg_{_os.getpid()}.csv")
    with open(seg_csv, "w", newline="", encoding="utf-8") as f:
        _csv.writer(f).writerows(segs)
    con.execute(f"""
        CREATE TABLE seg AS SELECT * FROM read_csv('{seg_csv}', header=false, nullstr='',
          columns={{'pid':'BIGINT','cc':'VARCHAR','province':'VARCHAR','city':'VARCHAR',
                    'ip_start':'BIGINT','ip_end':'BIGINT','plen':'BIGINT',
                    'origin_asn':'BIGINT','n_paths':'BIGINT'}});
    """)
    _os.remove(seg_csv)
    # 每前缀去重路径(<=PATH_CAP): paths_blob='|'拼接(供连续序列 LIKE) + best_path(最优路径)。
    # **从已写好的 paths parquet(已 top-24/pid、列存、可溢出)聚合**, 而非再对 47.5M 行 sqlite 做窗口
    # (窗口算子不溢出、易 OOM)。path_str 本就是 ' a b c ', string_agg('|') -> ' a b c | d e '。
    # 注意: string_agg **不要** 加 ORDER BY —— 有序聚合在 duckdb 里不落盘, 对 25M 行会 OOM。
    # paths_blob 仅用于 `LIKE '% seq %'` 连续序列匹配, 路径间顺序无关紧要; best_path 单列另取。
    con.execute(f"""
        CREATE TABLE pp AS
        SELECT pid,
               string_agg(path_str, '|') AS paths_blob,
               any_value(path_str) FILTER (WHERE is_best) AS best_path
        FROM read_parquet('{pq}/paths/*.parquet')
        GROUP BY pid;
    """)
    # 不用 Hive 分区(duckdb 不支持 PARTITION_BY + FILE_SIZE 同用; CF Pages 25MiB/文件硬限必须切文件)。
    # 改为**按 cc 排序 + 按 20MB 切文件**: WHERE cc='US' 仍能靠 row-group 的 cc min/max 做行级裁剪。
    # 分两步避免 OOM: (a) 先把 seg 按 (cc,city,pid) GROUP 成 segs 列表(无大字符串, 轻);
    # (b) 再 join 上 paths_blob(pp) 与 prefix(pfx, 物化为原生表避免 sqlite 扫描), 排序后写出(排序可溢出)。
    con.execute("CREATE TABLE pfx AS SELECT id AS pid, prefix FROM s.prefix WHERE family=4;")
    con.execute("""
        CREATE TABLE geo0 AS
        SELECT cc, city, any_value(province) AS province, pid,
               any_value(plen) AS plen, any_value(origin_asn) AS origin_asn,
               any_value(n_paths) AS n_paths,
               list({'s': ip_start, 'e': ip_end} ORDER BY ip_start) AS segs
        FROM seg GROUP BY cc, city, pid;
    """)
    # 物化 join 结果一次(无排序, 轻), 再**逐国家**写到 geo/<cc>/ —— 每文件单一 cc, cc 裁剪天然成立;
    # 国家内排序内存有界, 避免对带 paths_blob 的 1.13M 行做全局排序而 OOM。
    con.execute("""
        CREATE TABLE geo_full AS
        SELECT g.cc, g.city, g.province, g.pid, pfx.prefix, g.plen, g.origin_asn, g.n_paths,
               g.segs, pp.paths_blob, pp.best_path
        FROM geo0 g LEFT JOIN pp ON pp.pid = g.pid LEFT JOIN pfx ON pfx.pid = g.pid;
    """)
    (pq / "geo").mkdir(parents=True, exist_ok=True)
    ccs = [r[0] for r in con.execute(
        "SELECT DISTINCT cc FROM geo_full WHERE cc IS NOT NULL ORDER BY cc").fetchall()]
    util.log(f"  geo: 逐国家写出 {len(ccs)} 个国家...")
    for cc in ccs:
        # ROW_GROUP_SIZE 调小: geo 行带大 paths_blob, 默认 122880 行/组 -> 单组就 >16MB, FILE_SIZE 切不动。
        # 15k 行/组 (~7MB) 让 FILE_SIZE 能在组边界切到 16MB 以下 (< CF 25MiB)。
        con.execute(f"""
            COPY (SELECT * FROM geo_full WHERE cc='{cc}' ORDER BY city NULLS FIRST, n_paths DESC)
            TO '{pq}/geo/{cc}' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}',
                  ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
        """)
    n_geo_rows = con.execute("SELECT count(*) FROM geo_full").fetchone()[0]

    # pathsearch: **全表一行/前缀**(pid,prefix,cc,origin_asn,n_paths,paths_blob,best_path) —— 供前端
    # **不选国家**时做全局 AS_PATH(LIKE 全表扫) / origin AS(精确) 搜索。
    # **按 origin_asn 排序**: 让每个 origin 落在连续的 1 个文件里, 配合下面写入 meta 的 pathsearch_origin
    # 区间索引, 前端 origin 搜索只读覆盖该 ASN 的那 1 个文件(而非全部) —— 这是「预先 index 哪个 ASN 在哪个
    # 分片」+「分片更小」的落地。NULLS LAST 把无 origin 的前缀堆到末尾文件。排序走真盘 temp_directory(见 _duck)
    # 不会 OOM(1.13M 行/前缀级, 远小于 25M path 行)。AS_PATH(LIKE)搜索仍是全表扫, 不受排序影响。
    # 写这一份时强制**单线程 + 保留插入顺序**: 否则(默认 preserve_insertion_order=false / 多线程)COPY 写多文件
    # 不保证跨文件全局有序(每线程各刷自己的文件 -> origin 区间互相重叠, 索引退化成多文件命中)。
    # 单线程顺序写 + FILE_SIZE 滚动 -> 每文件是**互不重叠**的连续 origin 区间, origin 搜索只命中 1 个文件。
    # 1.13M 前缀级行, 单线程几秒即可。写完恢复原设置(后续无别的 COPY, 但保持对称)。
    import os as _os
    (pq / "pathsearch").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          SELECT p.id AS pid, p.prefix, COALESCE(p.country_code,'ZZ') AS cc,
                 p.origin_asn, p.n_paths, pp.paths_blob, pp.best_path
          FROM s.prefix p LEFT JOIN pp ON pp.pid = p.id WHERE p.family=4
          ORDER BY p.origin_asn NULLS LAST
        ) TO '{pq}/pathsearch' (FORMAT parquet, FILE_SIZE_BYTES '{PATHSEARCH_FILE_SIZE}',
              ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={_os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    # 6) meta.json: dfz_ref + 计数 + 国家/城市清单 + presets
    n_prefix = con.execute("SELECT count(*) FROM s.prefix WHERE family=4").fetchone()[0]
    n_paths_total = con.execute("SELECT count(*) FROM s.pathobs").fetchone()[0]
    dfz_ref = con.execute(
        "SELECT quantile_cont(n_paths, 0.9) FROM s.prefix WHERE family=4").fetchone()[0] or 1
    # 国家清单**从 geo_full 取**(carve 出的真实 cc), 保证每个列出的国家都有 geo/<cc>/ 目录 ——
    # 否则 COALESCE(...,'ZZ') 会把无 geo 的前缀塞进 ZZ 伪国家, 选它会 read_parquet 找不到文件而崩。
    countries = [{"cc": r[0], "n_prefix": r[1]} for r in con.execute(
        "SELECT cc, count(DISTINCT pid) c FROM geo_full WHERE cc IS NOT NULL "
        "GROUP BY cc ORDER BY c DESC").fetchall()]
    # cc -> 国家中文名(ipdb geo 里每个 cc 出现最多的 country 名) + 英文名(扫 ipdb)
    country_names = {r[0]: r[1] for r in con.execute(
        "SELECT country_code, mode(country) FROM s.geo "
        "WHERE country_code IS NOT NULL AND country IS NOT NULL GROUP BY 1").fetchall()}
    country_names_en = _ipdb_country_en(cfg.get("ipdb_path") or str(util.DEFAULT_IPDB))
    # 国家/地区名规范覆盖(CN/TW/HK/MO); 前端 regionName 也有同款覆盖。
    country_names.update({"CN": "中国大陆", "TW": "中国台湾", "MO": "中国澳门", "HK": "中国香港"})
    country_names_en.update({"CN": "Chinese Mainland", "TW": "Taiwan, China", "MO": "Macao", "HK": "Hong Kong"})
    focus_cc = sorted(_focus_countries(cfg))
    cities = {}
    for cc in focus_cc:
        rows = con.execute(
            "SELECT city, count(DISTINCT pid) c FROM seg WHERE cc=? AND city IS NOT NULL "
            "GROUP BY city ORDER BY c DESC", [cc]).fetchall()
        if rows:
            cities[cc] = [{"name": r[0], "n_prefix": r[1]} for r in rows]
    # 显式文件清单: DuckDB-WASM 走 HTTP 不能 glob, 前端用此清单做 read_parquet([...])。
    def _rel(sub):
        d = pq / sub
        return sorted(str(p.relative_to(pq)).replace("\\", "/")
                      for p in d.rglob("*.parquet")) if d.exists() else []
    files = {
        "prefixes": _rel("prefixes"),
        "paths": _rel("paths"),
        "pathsearch": _rel("pathsearch"),
        "geo": {cc: _rel(f"geo/{cc}") for cc in ccs},
    }
    # paths 每文件的 pid 区间: 前端 insight 据此只读命中那个文件(否则一次拉几十个文件)。
    paths_pid = []
    for f in files["paths"]:
        lo, hi = con.execute(f"SELECT min(pid), max(pid) FROM read_parquet('{pq}/{f}')").fetchone()
        if lo is not None:
            paths_pid.append({"f": f, "lo": int(lo), "hi": int(hi)})
    paths_pid.sort(key=lambda e: e["lo"])
    files["paths_pid"] = paths_pid

    # pathsearch 每文件的 origin_asn 区间: 前端 origin AS 搜索据此只读覆盖该 ASN 的文件(否则全表扫所有分片)。
    # 文件已按 origin_asn 排序 -> 每文件是一段连续 origin 区间; min/max 忽略 NULL, 末尾全 NULL 文件 lo=None(origin 搜索跳过)。
    ps_origin = []
    for f in files["pathsearch"]:
        lo, hi = con.execute(f"SELECT min(origin_asn), max(origin_asn) FROM read_parquet('{pq}/{f}')").fetchone()
        ps_origin.append({"f": f, "lo": (int(lo) if lo is not None else None),
                          "hi": (int(hi) if hi is not None else None)})
    files["pathsearch_origin"] = ps_origin

    now = int(time.time())
    # 数据版本: 文件清单(含各文件区间索引)+计数+时间 的短哈希。前端把它作为 ?v= 拼到所有 parquet/json URL 上,
    # 数据一变 version 就变 -> URL 变 -> 浏览器/CDN 旧缓存自动失效, 拉到新数据(解决"固定 URL 内容变了仍命中旧缓存")。
    import hashlib as _hashlib
    version = _hashlib.sha1(json.dumps(
        {"files": files, "n_prefix": int(n_prefix), "n_paths": int(n_paths_total), "ts": now},
        sort_keys=True).encode()).hexdigest()[:12]
    meta = {
        "version": version,
        "files": files,
        "generated_ts": now,
        "generated_str": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)),
        "scope": "global",
        "site_base": cfg.get("site_base") or "https://bgp-insights.pages.dev",
        "counts": {"prefixes": int(n_prefix), "paths": int(n_paths_total),
                   "segments": len(segs)},
        "dfz_ref": int(round(dfz_ref)),
        "countries": countries,
        "country_names": country_names,
        "country_names_en": country_names_en,
        "focus_countries": focus_cc,
        "cities": cities,
        "path_presets": cfg.get("path_presets") or [],
        "focus_asns": bgp.resolve_asns(cfg.get("focus_asns") or []),
        "asn_names": {str(a): v["name"] for a, v in bgp.ASN_REGISTRY.items()},
        "asn_ops": {str(a): v["op"] for a, v in bgp.ASN_REGISTRY.items() if v.get("op")},
    }
    (data).mkdir(parents=True, exist_ok=True)
    (data / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # 7) SSG: 为爬虫生成预渲染的双语国家落地页 + sitemap + robots(WASM 查询站本身对爬虫不可见)
    from . import ssg
    n_ssg = ssg.generate(out, meta, con, asnames)
    con.close()

    # 统计产物
    total_bytes = sum(p.stat().st_size for p in pq.rglob("*.parquet"))
    n_pqfiles = sum(1 for _ in pq.rglob("*.parquet"))
    return {"out": str(out), "parquet_files": n_pqfiles, "parquet_bytes": total_bytes,
            "prefixes": int(n_prefix), "paths": int(n_paths_total), "segments": len(segs),
            "countries": len(countries), "dfz_ref": int(round(dfz_ref)), "ssg_pages": n_ssg}
