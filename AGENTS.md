# AGENTS.md — PEER.AS 维护 & 部署指南

> **本项目今后只由 agent 维护。本文件是唯一权威维护文档**：默认读者是一个**无任何先验上下文**的
> agent。请保证读完即可独立维护并发版；**任何改动后同步更新本文件**。
> （README 面向人类、偏介绍；本文件面向 agent、偏操作。）

本项目 = 自研 CLI `ipc`（python 包 `ipcollect/`，用同目录 `.venv`）+ 纯静态 Web 看板
**PEER.AS（全球版 BGP Insights）**。从 RIPE **rrc01+rrc06** 双采集点 MRT **全表(IPv4+IPv6)** 静态分析回程 AS_PATH，
**入库 = 全球全部 v4+v6 前缀**（不按 ASN/国家过滤，focus_* 仅作高亮/导航），用 **DuckDB 工作库**去重，导出
**Parquet** 数据集（v4 + v6 两套），**DuckDB-WASM 在浏览器里发 HTTP Range 查询**（无后端），部署到 Cloudflare Pages。
**重构细节见 `docs/DUCKDB_V6_REFACTOR.md`（DuckDB+v6 设计契约, 含踩坑记录), 旧版见 `docs/GLOBAL_DESIGN.md`。**

> 规模实测(2026-06 rrc01+rrc06)：**1.10M v4 + 0.26M v6 前缀 / 50.3M 去重路径**。
> **中间库 = DuckDB**(`ipcollect.duckdb`, 跑完即弃, 已 gitignore；SQLite 已退役)。
> **IP 列用 `UHUGEINT`**(无符号 128 位, 同时容纳 v4/v6；**比较要 `::UHUGEINT` cast**, 否则 DuckDB 推断成有符号
> HUGEINT 会让 v6 溢出)。**4 字节 ASN(>2^31)用 BIGINT**，勿用 INT32。
> **地理以 geo 库为准**（不靠前缀首 IP）：ingest 不打 geo；导出时按 geo **切成各国家/城市子段**(carve, 已算成 CIDR 串)，
> 前缀出现在它覆盖的每个地区里。geo 三轨合并为**非重叠**区间：`ipdb`(私有, **CN 城市级**) +
> `GeoLite2-City`(**非 CN 全球城市级**, 含 v4+v6) + `rir`(国家级开放兜底)；另 `GeoLite2-ASN` 出 AS organization。

## 脱敏约定（重要）

本仓库面向公开/可镜像，**不得提交任何密钥或机器特定敏感信息**：
- **密钥/账户**：Cloudflare account id、API token 等一律走环境变量（见 `.env.example`），不写进任何提交文件。
- **`config.json`**：已 gitignore（仅本机配置，无密钥）；提交的是 `config.example.json`。
- **geo 库**：私有商业库 `ipdb.txt` 已 gitignore，**不可随仓库再分发**；路径可用 `IPC_IPDB_PATH` 覆盖。
- **`.wrangler/`**：已 gitignore（含 account id 缓存）。
- 已移除「存活探测」整套（Shodan + ICMP/TCP probe）；勿再引入第三方密钥依赖。

## 架构 / 文件地图（`ipcollect/`）
- `cli.py` — `ipc` 子命令入口（argparse）。**只保留部署/处理快捷入口**：`init`/`config`/`geo-import`/`ingest`/
  `build`/`export-parquet`/`sync-web`/`serve`。**查询入口(query/stats/insight/geo-lookup)已退役**(source of
  truth = 原始 MRT, 调试直接用 DuckDB 查工作库或 parquet)。
- `config.py` — `DEFAULT_CONFIG` + `load/save`；`asn_registry`/`mrt_collectors`(=`[rrc01,rrc06]`)/`geolite_*` 集中在此，
  `load()` 时调 `bgp.set_registry()` 灌入。
- `bgp.py` — AS_PATH 清洗、ASN 命名（运行时由 config 灌入）、`path_contains_seq`（**连续子序列**）、`resolve_asns`。
- `mrt.py` — 自写流式 MRT RIB 解析(已支持 v4+v6)；下载**断点续传+重试**；`ingest()`：遍历 `mrt_collectors`,
  收全表 v4+v6, Python 端按 (prefix,path) 去重写 `obs`(带 collector), 末尾 `store.finalize()` 跨 collector 合并出
  `pathobs`/`prefix`。ingest 前先 `geoip.ensure_geolite`(过期才下) + 缺/更新时 `build_geo`。`--family 4/6` 调试限族。
- `store.py` — **DuckDB 工作库**(取代 SQLite)。`connect`(套 IPC_DUCKDB_* + cache/duck_tmp 溢出)、`obs`/`meta` 表、
  `ObsWriter`(CSV 流式写)+`load_csv`(read_csv+`::UHUGEINT` cast 批量灌)、`finalize`(GROUP BY 去重 → pathobs/prefix + pid)。
  `util.uhuge_halves` 拆 hi/lo 两个 UBIGINT 取(避开 UHUGEINT→python 慢转换)。
- `geoip.py` — `ensure_geolite`(查 GitHub release tag, 过期才下 GeoLite mmdb)、`build_geo`(ipdb CN + GeoLite 非 CN
  合并非重叠 geo + `coalesce_geo` 合并同城段 + `asn_dim`(org) + `country_dim`)、`GeoIndexDuck`(从 DuckDB 按 family
  内存 bisect, hi/lo 快载)、`carve_cc(start,end,cap)`(超大聚合前缀退化国家级单段防炸)。旧 `import_ipdb/GeoIndex`(读
  SQLite) 仍在但新管线不用。
- **`parquet_export.py`** — `ipc export-parquet`：直接读 DuckDB 工作库(无 ATTACH)，按 family 出**两套** Parquet
  (`prefixes{,_v6}`/`paths{,_v6}`/`pathsearch{,_v6}`/`geo{,_v6}/<cc>`)+ `asnames.json`/`asnorg.json` + `meta.json`，调 `ssg`。
  v4 IP 列导 BIGINT、v6 导 UHUGEINT；segs **预算成 CIDR 串列表**(前端直接显示, 不必对 v6 做 BigInt)；代表 cc 走 ASOF join。
  `_forest_duck`/`_subtract`/`_segments_duck` 是 carve(纯 Python, 位宽无关)。`copy_web()` 只拷前端。**主战场**。
- **`ssg.py`** — 每国家双语 SEO 落地页 `c/<cc>.html` + `countries.html` + sitemap/robots；`_origins` 读导出期建的 `pgeo`。
- `serve.py` — 本地 debug 静态托管(支持 Range)；`--rebuild` 只重拷前端(数据需 `export-parquet`)。
- (已删) `db.py`/`report.py`/`build.py` —— SQLite schema / CLI 查询渲染 / 旧 JSON 导出, 随 SQLite 退役删除。
- **`web/`** — 前端 = **Vite + Svelte 5 项目**(不再是裸 JS)。`src/App.svelte` + `src/components/*`(Sidebar/
  Topbar/Results/InsightDrawer/PathGraph/AboutModal/AsnTag/AsPath/Field) + `src/lib/*`(store.svelte.js 全局
  runes 状态、db.js DuckDB-WASM、queries.js 搜索/insight、bgp.js、i18n.js、icons.js Font Awesome、ui.js)。
  Console 暗色设计 + **系统默认字体**(勿强制自定义 web 字体, 中文会糊) + FA 图标 + teal/amber。**改完要 `npm run build`**(产出 `web/dist/`),
  `export-parquet` 再把 `web/dist/` 拷进 `dist/`。`web/test-e2e.mjs` = puppeteer-core 无头冒烟测试(用系统 Chrome)。

## 数据表（DuckDB 工作库 `ipcollect.duckdb`，`store.py`/`geoip.py` 建）
- `obs` — ingest 中间观测(每 collector 去重后的 (prefix,path) 行 + n_peers + collector)；finalize 后可弃。
- `pathobs`(pid + 去重 AS_PATH + n_peers, 跨 collector 合并) · `prefix`(每前缀 + pid + ip_start/end `UHUGEINT` +
  family + 代表 origin + n_paths) · `geo`(非重叠区间 + family + cc/prov/city + provider) · `country_dim`(cc→zh/en 名) ·
  `asn_dim`(asn→org) · `meta`(kv, 含 `geo_tag` GeoLite 版本)。导出期还建临时 `pgeo`(前缀+代表 cc, ASOF)。

所有命令在仓库根目录下用 `./ipc <子命令>`（启动器自动走 `.venv`，数据/缓存落本目录）。

---

## 配置（config.json，集中维护、勿 hard code）

```bash
./ipc config show
./ipc config set focus_asns 4809,23764,9929,4837,58807,...   # path 含这些即入库
./ipc config set focus_cities 北京,上海,广州,深圳,...          # 展示时切到这些城市
```

- `focus_asns`：入库过滤器（path 含任一即收；改了**需重新 ingest**）。
- `focus_cities`（~59 个，一线+新一线+二线+省会）**不用于 ingest**，而是**面板展示的城市集**：build 只把
  前缀切到这些城市(`carve(…, city_set)`)，城市框只列它们。改 `focus_cities` 只需重新 `build`(不必 reingest)。
- `focus_country_code`：ingest 国家过滤（默认 `CN`，空=不限）；`ingest --all-countries` 临时不限。
- `path_presets`：面板/CLI 的预制 path 下拉项 `[{alias, path:[asns]}]`。
- `asn_registry`：ASN→`{name, op}`（展示/下拉/着色用），`config.load()` 时灌入 `bgp` 模块。

---

## 数据维护流程

### 0) geo 库（**通常不用手动跑** —— ingest 会自动检查 GeoLite 是否过期并按需重建 geo）
```bash
./ipc geo-import                      # 手动重建 geo: ipdb(CN城市)+GeoLite2-City(非CN全球,v4+v6)+asn_dim(org)
./ipc geo-import --force-download     # 强制重下 GeoLite mmdb(忽略本地版本戳)
./ipc geo-import --no-geolite         # 只用 ipdb(CN), 不叠 GeoLite
```
GeoLite mmdb 缓存在 `cache/geo/`(+ `geolite.version` 戳)。**首次 geo-import 较慢(~11min: 遍历 5.8M 段 + 非重叠合并)**, 只在 GeoLite 更新时重跑。

### 1) 全表 ingest 最新 RIB（双采集点, v4+v6）
```bash
./ipc ingest --reset                  # 下载 rrc01+rrc06 最新 RIB(各~350MB/40MB), 全表 v4+v6 入 DuckDB; 约 15-20 分钟
# 复用本地已下: ./ipc ingest --reset --mrt-file cache/mrt/<file>.gz   # 单文件, 调试
# 只收某族: ./ipc ingest --reset --family 6
```
入库 = **全球全部 v4+v6 前缀**(不过滤)。ingest 会**先检查 GeoLite 过期**(过期才下), geo 表缺失或 GeoLite 更新时
自动 `build_geo`(否则复用; `--reset` 只清 obs/pathobs/prefix, **不清 geo**)。改采集点(`config mrt_collectors`)需重 ingest。

### 2) 导出 Parquet + SSG（主发布步骤）
```bash
./ipc export-parquet --out dist       # DuckDB -> dist/data/parquet/*(v4+v6) + meta.json + SSG(c/<cc>.html…), 约 3-5 分钟
```
注意: duckdb 溢出目录走真盘(`cache/duck_tmp`; /tmp 是 tmpfs/RAM 会 OOM)。内存紧可设
`IPC_DUCKDB_MEM=8GB IPC_DUCKDB_THREADS=2`。**v6 的 128 位别直接取进 Python**(慢)/取进前端(丢精度)——见 `docs/DUCKDB_V6_REFACTOR.md §8`。

### 2.5) 只改前端（免重导出）

前端代码改完、**数据(parquet/meta/SSG)没变**时，不必跑耗时的 `export-parquet`，一条命令搞定：
```bash
./ipc build             # = npm run build(ipcollect/web) + 拷 web/dist -> dist/; 不碰数据。日常改前端就用它
./ipc build --no-npm    # 跳过 npm、只拷已构建的 web/dist(等价旧 sync-web)
./ipc sync-web          # 同 --no-npm: 只拷 web/dist -> dist/(web 已 build、不想重跑 npm 时用)
```
`ipc build` 跑 Vite 构建再调 `parquet_export.copy_web`(清旧 assets, 保留 `data/` 与 SSG)；秒级。
**仅当 ingest/数据/geo/SSG 变了才需要重新 `export-parquet`。** 本地预览同理：`ipc build` 后 `./ipc serve` 刷新即生效。

### 3) 查 / 看（调试）
CLI 查询入口已退役。调试直接用 DuckDB 查工作库或产物 parquet:
```bash
.venv/bin/python -c "import duckdb;c=duckdb.connect('ipcollect.duckdb',read_only=True);\
print(c.execute('SELECT family,count(*) FROM prefix GROUP BY family').fetchall())"
# 或对导出的 parquet: duckdb -c "SELECT * FROM read_parquet('dist/data/parquet/prefixes_v6/*.parquet') LIMIT 5"
```
本地看站: `./ipc serve` 后浏览器开 http://127.0.0.1:8787/(支持 Range, 与生产一致)。

---

## 更新日志（CHANGELOG，重要约定）

仓库根 `CHANGELOG.md` 是**单一数据源**：网站「更新日志」弹窗由前端 `?raw` 直接 import 它（构建期内联，
见 `web/src/components/ChangelogModal.svelte`），故**网站与仓库永远一致，改一处即可**。
- **每次新增/改动「面向用户的功能」都必须在 `CHANGELOG.md` 顶部追加一条**（中英双语，最新在上，按日期分组）。
- **纯维护性改动不写**（重构、依赖升级、数据每日刷新、文档/措辞、性能调优等无可见行为变化的）。
- 格式跟随现有条目即可（`## YYYY-MM-DD` 分组 + `- **新增/改进：…**` 列表项）。改了它前端要重新 `npm run build`。

## 构建 & 部署（Cloudflare Pages）

**维护改动：直接 build + export-parquet + 推，无需再确认（用户已授权直接推）。**

```bash
# A) 只改了前端(web/, 含 CSS): 一条命令构建+拷进 dist(npm run build + copy_web), 不碰数据:
./ipc build                       # 首次/换机若缺依赖: (cd ipcollect/web && npm ci) 再 ./ipc build
# B) 改了数据(ingest/geo/SSG): 重导出(含拷前端):
./ipc export-parquet --out dist
# 部署(账户/token 走环境变量, 见 .env.example; 或 wrangler login):
#   --commit-message 用 ASCII: 不带时 wrangler 自动读 git 提交信息, 中文有时报 Invalid UTF-8。
wrangler pages deploy dist --project-name bgp-insights --branch main --commit-dirty=true --commit-message="..."
# 前端无头自检(可选, 用系统 Chrome): ./ipc serve --port 8812 & ; cd ipcollect/web && node test-e2e.mjs
```

部署事实：
- **品牌/域名**：**PEER.AS**，主域名 **https://peer.as**（用户自有域名）。`site_base` 已设为 `https://peer.as`
  （SEO canonical/sitemap/SSG 用）。`peer.as` 作为**自定义域名**绑在下面的 Pages 项目上。
- **Pages 项目**：`bgp-insights`（项目内部名不变，与主站 `opentrace` 分开；`bgp-insights.pages.dev` 仍为部署目标/备用）。
- **绑定自定义域名**(在 CF 控制台/或有 DNS 权限的 token 做)：Pages 项目 `bgp-insights` → Custom domains → 加 `peer.as`
  + 在 DNS 加 CNAME/记录指向 `bgp-insights.pages.dev`。**wrangler 部署 token 无 DNS 写权限**，此步需在控制台手动。
- **凭据**：CF account id / API token 通过环境变量(`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`)
  或 `wrangler login` 提供；`.wrangler/` 与 `.env` 均已 gitignore，**不得写进提交文件**。
- 前端是 Vite+Svelte 编译产物(`web/dist/`)拷进 `dist/`；CF Pages 侧无构建命令；`./ipc serve` 仅本地 debug。
- **HTTP Range / 缓存（关键）**：DuckDB-WASM 靠 HTTP Range 部分读 Parquet。CF **只对命中边缘缓存的资源回 206**；
  Pages 默认给所有资源发 `cache-control: max-age=0, must-revalidate`（不可缓存）⇒ Range 退化成整文件下载。
  修复：`web/public/_headers`（Vite 拷进 `dist/`）把 `/assets/*` 与 `/data/parquet|prefixes/*` 设长缓存(可缓存才有 Range)、
  `/data/meta.json` 设 `no-cache`、`/data/asnames.json` 长缓存(显式列, 别用 `/data/*.json` 否则会和 meta.json 规则叠加)。
  **`*.pages.dev` 走 Pages 资源路由、可能仍回 200 全量**（实测全表搜索因此较慢）；
  **Range/边缘缓存在自定义域名 `peer.as`（走完整 CF CDN）上才生效**。改 `_headers` 后重新 deploy 即可（其余文件秒级跳过）。
- **数据版本 / 缓存失效（关键）**：parquet/json 路径固定(`prefixes/data_4.parquet`)但内容每次 export 都变 ⇒ 固定 URL +
  长缓存会让浏览器/CDN 读到**过期分片**(曾导致高位 prefix 搜不到、隐私窗口却能搜到)。修复：`meta.version`=文件清单+计数+ts
  的 sha1 短哈希；前端 `dv()`(db.js) 把 `?v=<version>` 拼到**所有** parquet/asnames URL 上(经 `rpList`)，数据一变 version
  变 → URL 变 → 旧缓存失效。`meta.json` 自身用 `cache:'no-cache'` 取且 `_headers` 也 `no-cache`(它是 version 源, 必须最新)。
  因此 parquet 可放心设 1 年长缓存。**改了数据务必重新 export(刷新 version)再 deploy**。

发版自检：
```bash
test -f dist/index.html && grep -oE 'assets/index-[^"]+\.js' dist/index.html   # 前端 bundle 已进 dist
curl -s -o /dev/null -w "%{http_code}\n" https://peer.as/                        # 或 bgp-insights.pages.dev
```

### 数据分离托管（R2，可选）

把 **前端(Pages)** 与 **Parquet 数据** 拆开:前端仍部署到 Pages,数据放独立宿主(Cloudflare R2)。
前端只认一个根 URL(`VITE_DATA_BASE`),数据放哪儿都行;留空则回退同源 `dist/data`(默认行为不变)。

- **前端开关**:`db.js` 的 `DATA` 取 `import.meta.env.VITE_DATA_BASE || ./data`;`vite.config.js` 设
  `envDir:'../../'` 让 web 构建读 **仓库根 `.env`**(与 `CLOUDFLARE_*` 同住)。Vite 仅暴露 `VITE_` 前缀 ⇒
  凭据不入 bundle。**非公开 id 一律走 env**:account id=`CLOUDFLARE_ACCOUNT_ID`、含账号 hash 的
  `pub-<hash>.r2.dev`=`VITE_DATA_BASE`、桶名=`R2_BUCKET`;真实值只在 `.env`,勿写进任何提交文件。
- **一次性建桶 + 公开 + CORS**(`$R2_BUCKET` 取自 `.env`):
  ```bash
  wrangler r2 bucket create "$R2_BUCKET"
  wrangler r2 bucket dev-url enable "$R2_BUCKET" -y      # 得 https://pub-<hash>.r2.dev (=VITE_DATA_BASE)
  # 或改绑自定义域名: wrangler r2 bucket domain add "$R2_BUCKET" --domain data.peer.as
  wrangler r2 bucket cors set "$R2_BUCKET" --file cors.json -y
  ```
  CORS JSON 必须是 `{"rules":[{...}]}` 结构(非 S3 风格):`allowed.{origins,methods:[GET,HEAD],headers:[range]}`
  + **`exposeHeaders:[Content-Range,Content-Length,ETag,Accept-Ranges]`**(不暴露 Content-Range,DuckDB 拿不到 206)
  + `maxAgeSeconds`。
- **上传数据**(把 `dist/data/` 整树镜像到桶,key=相对路径):
  ```bash
  cd dist/data && find . -type f -printf '%P\n' | \
    xargs -P 8 -I{} wrangler r2 object put "$R2_BUCKET/{}" --file={} --remote
  ```
  **`--remote` 必加**:`wrangler r2 object put` **默认写本地 miniflare 模拟**(无报错、但远端查无此 key),漏了会 404。
- **构建 + 部署**:`.env` 填好 `VITE_DATA_BASE` 后照常 `npm run build`(envDir 自动注入)→ `export-parquet`(仍会
  拷 `dist/data`,但前端不再读它,可后续精简)→ `wrangler pages deploy`。**数据变更后:先重新 export 刷新
  `meta.version`,再上传 R2,再 deploy**——`?v=` 缓存失效机制对 R2 同样生效(URL 带 `?v=`)。
- **HTTP Range — 前端实际不用(实测重要结论)**:R2/data.peer.as 支持 `206 Partial Content`(`curl` 带 `Range`
  可得),但 **DuckDB-WASM 前端并不发 Range 请求**。实测两路验证(本地带日志数据服务器 + 对生产 data.peer.as
  用 CDP 抓 Web Worker 流量)一致:**每个被触及的 parquet 分片都是 1 次探测 + 1 次无 Range 头的 `200` 整文件下载,
  零 `206` 部分读**。因 DuckDB-WASM 对 <25MiB 小文件判定"整下比多次 Range 往返快",直接整取。
  ⇒ **迁 R2 的收益是 egress 免费 / 突破 Pages 25MiB 与文件数限制 / 卸掉 ~633MB,不是 Range 提速;查询传输量
  与旧 Pages 同(都整下)**。真正决定每次查询下载多少的是**文件级裁剪**(下一条)。
- **真正的优化 = meta 索引的文件级裁剪**(不是文件内 Range):查询只 `read_parquet` 相关分片再整下。实测单次查询传输:
  小国 geo ~10KB、大国(US)~44MB(3 分片)、IP/CIDR ~22MB(**全部 5 个 prefixes 分片**)、origin-ASN ~6.7MB
  (经 `pathsearch_origin` 索引只取 1/18 分片 ≈ 18× 节省)、insight ~一个 paths 分片、**纯 AS_PATH 无 origin = 最坏:
  全扫 18 个 pathsearch ≈ 119MB**。优化方向应针对"减少整下字节":更细分片 / 更强压缩 / 热路径去列,而非指望 Range。
- **缓存**:R2 侧 `_headers` 不适用;data.peer.as 实测对所有请求回 `DYNAMIC`(直读 R2、不边缘缓存)⇒ 永远最新、无 stale,
  `?v=` 对其冗余但无害。
- **验证**:`curl -s -D - -o /dev/null -H 'Origin: https://peer.as' -H 'Range: bytes=0-1023'
  "$VITE_DATA_BASE/parquet/prefixes/data_0.parquet"` 应见 `206` + `Content-Range` + `Access-Control-Allow-Origin`;
  端到端用 `VITE_DATA_BASE=... npm run build` 后起静态服务跑 `web/test-e2e.mjs`(覆盖 geo/paths/pathsearch 三类查询)。
  注:`test-e2e.mjs` 当前与 UI 字段布局不同步(期望 5 输入框、实测 4——origin 已并入智能框)在国家查询步骤会误报
  失败,**与 R2 无关**;验证 R2 用 `?cc=CN` 深链更可靠。**抓 DuckDB 真实请求**:`page.on('response')` 抓不到 Web
  Worker 流量,要用 **CDP `Target.setAutoAttach`(flatten)** 逐 worker 目标 `Network.enable`(见
  `verify/cdp-capture` 思路);或用带日志的本地数据服务器从服务端记录。
- **状态(2026-06-01, 已固化)**:生产 `peer.as` 已切到 R2 数据源,`VITE_DATA_BASE=https://data.peer.as`
  (桶 `peer-as-data` 的**自定义域名**, 走 peer.as 完整 CF CDN, 无 r2.dev 限速; 桶含全量 423 对象)。
  迁移收益是 egress/限制/架构(见上「HTTP Range」),**非 Range 提速**——前端整下分片,Pages 与 R2 传输量相同。
  自定义域名绑定:`wrangler r2 bucket domain add peer-as-data --domain data.peer.as --zone-id <peer.as的zoneid> --min-tls 1.2`
  (zone id 属非公开值, 用 API `GET /zones?name=peer.as` 取, 勿写进提交文件)。`dist/data/` 仍随 Pages deploy
  上传(前端已不读, 属冗余兜底, 可后续从部署产物剔除以缩小 Pages)。
- 切换若要回退:把 `.env` 的 `VITE_DATA_BASE` 清空 → `npm run build` → 部署, 前端即回退同源 `dist/data`。

### 中国优化（cn.peer.as）

**问题**：CF Pages/R2 在中国大陆慢(anycast 跨境被限速/丢包，RTT ~450ms)。**方案**：一台中国优化线路的
VPS(DMIT LAX，`cn.peer.as` 灰云直连)用 **Caddy** 托管**全部数据 + 自托管 DuckDB-WASM**，前端**运行时按
地区分流**：`loc=CN` 走 VPS、其余走 CF/R2，并带**健康探测 + 自动回退**。

**前端如何分流(`web/src/lib/db.js` `configure()`，App.svelte onMount 最先调)**：
- 同源 `GET /cdn-cgi/trace`(CF 才有，本地/非CF 取不到 ⇒ 当作非 CN) 解析 `loc=CN`。
- CN 则**健康探测** `https://cn.peer.as/data/meta.json`(超时 2s)，通了才把数据源 `DATA` 切到
  `cn.peer.as/data`、wasm 源 `DUCK_SRC` 切到 `cn.peer.as/duckdb`；**探测失败/超时 ⇒ 保持 CF/R2**。
- `getData()`(meta/asnames)再带一层 try-CN→回退-CF；parquet 的 DuckDB 取数无逐请求回退，靠启动探测把关。
- 覆盖：`VITE_CN_BASE`(默认 `https://cn.peer.as`)。

**DuckDB-WASM 自托管 + Cache Storage(核心修复)**：`duckdb-eh.wasm` 解压 **34MB**，**超出 Chromium HTTP
磁盘缓存单资源上限(`max_size/8`) ⇒ 每次刷新都跨境重下 ~9MB**。修法(`initDuck` + `cachedBlobURL`)：手动
bundle(mvp+eh，无 COI) 指向选定源 → wasm/worker.js **存入 Cache Storage(无单资源上限)**，以 blob: URL 喂给
duckdb(wasm blob 标 `application/wasm` 走 instantiateStreaming；worker.js 自包含，cached text 直接 `new
Worker`)。**首装后每次加载/F5 本地命中、零跨境**。键与宿主无关(`__duckdbwasm__/<variant>.*`)，主源失败回退
jsDelivr。缓存名带版本(`duckdb-wasm-1.32.0`)，升级 duckdb 自动弃旧。加载器 `+esm`(32KB) 仍走 jsDelivr(小、能
HTTP 缓存；**后续可自托管整条 ESM 链以防 jsDelivr 被全墙**)。**Service Worker**(`public/sw.js`)只缓存同源壳
(HTML network-first 防陈旧 hash、`/assets/*` cache-first)，不碰数据/跨源(wasm 由上面的 Cache Storage 管)。

**VPS 状态(已部署并实测，2026-06-01)**：Debian 12 / Caddy v2.11 / BBR+fq 已开 / 无防火墙。
- **HTTP/3 已全局禁用(只留 h1/h2，Caddyfile 顶部 `servers { protocols h1 h2 }`)**：中国对 UDP/QUIC
  做 QoS 限速，走 h3 反而更慢；本机仅服务 CN ⇒ 全局关即可(海外走 CF 不受影响)。关后不监听 UDP/443、不广播 alt-svc h3。
- 目录：`/var/www/cn/data`(parquet，rsync 自 `dist/data`) + `/var/www/cn/duckdb`(4 个 wasm 文件)。
- 配置：`deploy/cn.peer.as.Caddyfile` → `/etc/caddy/Caddyfile`(Caddy 自动签 LE 证书)。**要点**：
  CORS `*` + Expose `Content-Range` 等 + OPTIONS 预检 204；`encode` **只排除 `*.parquet`**(它走 Range，压缩
  破坏 206)，**wasm 照压**(34MB→8MB，整块取非 Range)；parquet/duckdb 长缓存 immutable、meta.json no-cache。
  访问日志走 journald(`journalctl -u caddy`；systemd 沙箱下写 `/var/log` 被拒，故未用 file log)。
- 实测：parquet 206+Range+CORS 不压缩；wasm `content-encoding: gzip` 下载 8MB；预检 204；h3 已禁用(无 alt-svc)；
  浏览器实测 F5 不再重下 wasm(命中 Cache Storage)、`?cc=CN` 查询 500 行正确。

**VPS 重建/维护**：
- 数据：daily-refresh **步骤 4/5** rsync(`.env` 的 `CN_DEPLOY_SSH`/`CN_DEPLOY_PATH`；best-effort，失败不阻断)。
- 首次/换机装 Caddy：官方 apt 源装 `caddy`，scp `deploy/cn.peer.as.Caddyfile` → `/etc/caddy/Caddyfile`，
  `caddy validate && systemctl reload caddy`。DNS 须先把 `cn.peer.as` 灰云 A 记录指向本机(否则签证书失败)。
- duckdb wasm(不随 daily 同步，仅**升级 duckdb 版本**时重置)：在 VPS 上
  `cd /var/www/cn/duckdb && for f in duckdb-mvp.wasm duckdb-browser-mvp.worker.js duckdb-eh.wasm
  duckdb-browser-eh.worker.js; do curl -sO https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@<VER>/dist/$f; done`，
  并同步改前端 `DUCKDB_VER`(db.js) + `WASM_CACHE` 缓存名随之失效。

### 自动化：每天 04:00 自动刷新 + 部署（cron）

数据每日自动刷新：`scripts/daily-refresh.sh` 串起 `ingest --reset` → `export-parquet --out dist` →
**sync R2** → **sync VPS(cn.peer.as)** → `wrangler pages deploy`，由 **fcron** 每天 **04:00** 触发。
- **VPS 同步步(步骤 4/5)**：rsync `dist/data` → `$CN_DEPLOY_SSH:$CN_DEPLOY_PATH/data`(数据先、meta 最后，同
  R2 语义)；best-effort，失败只告警不阻断(CN 用户回退 CF/R2)。未设 `CN_DEPLOY_SSH` 则跳过。
- **R2 同步步(步骤 3/5, 切 R2 后关键)**:export 后把 `dist/data/` 镜像到 `$R2_BUCKET`(脚本从 `.env` 读),
  `--remote` 必加;**数据先传、`meta.json` 最后传**——R2 逐对象上传非原子, meta 是 version 源, 若数据没传全
  就**跳过 meta**(R2 维持上一致版本, 宁旧勿错位);单文件重试 3 次抗瞬时限流。失败清单写 `logs/r2-fails-<ts>.txt`。
- 安装/查看：`fcrontab -l`（条目 `0 4 * * * .../scripts/daily-refresh.sh`）。改时间：`fcrontab -e` 或重灌。
- 脚本要点：补 `PATH`(含 `/usr/lib/node-24/bin`，cron 默认 PATH 找不到 node/wrangler) 与 `HOME`(wrangler 读
  `~/.config/.wrangler` 的 **OAuth 凭据**，会自动续期，无需 `.env`)；`flock` 串行锁防重 ingest 撕裂库；
  日志写 `logs/daily-refresh-<ts>.log`(gitignore，留最近 14 份)。
- **开跑先清缓存(防撑爆硬盘)**：每次运行先删 `cache/mrt/*.gz`(每版 RIB ~425MB，ingest 会重新下最新) 与
  `cache/duck_tmp/*`(export 溢出残留)，删完再下载 ⇒ 同时只存 1 份 RIB。保留 `cache/autnums.txt`(小, 复用)。
- **不跑 `npm run build`**：前端源每日不变，`web/dist/` 由 `export-parquet` 拷进 `dist/`；改了前端要人工先 build 再让它生效。
- 手动试跑：`./scripts/daily-refresh.sh`（与 cron 完全同路径；约 15 分钟）。看日志：`tail -f logs/daily-refresh-*.log`。
- 凭据失效（OAuth 过期/换机）会导致 deploy 步骤失败：重跑 `wrangler login` 即可恢复。

---

## 前端要点（`web/` Svelte 源；改完要 `npm run build` + `ipc export-parquet` 才进 dist）
- DuckDB-WASM 在浏览器发 SQL over 远端 parquet(HTTP Range)。**BigInt**：q() 只降顶层；嵌套 list<struct>
  (segs.s/e)要 `Number()`。i18n zh/en(`Intl.DisplayNames` + STRINGS), `?lang/?cc/?city` 深链。
- 搜索 = `geo/<cc>` 里 `paths_blob LIKE '% seq %'`(连续序列)；`best_path LIKE` 命中最优路径**置顶★**。
- **国家可不选 = 全表搜索**(读 `pathsearch`, 一行/前缀)：AS_PATH(`paths_blob LIKE`, 全表扫、较慢) 或
  **origin AS**(`origin_asn=X`, 精确)。选了国家则走 `geo/<cc>`(带城市级+本段)。
  (已移除「预制 path 下拉」与「kw 模糊搜索」，改为通用的 path 输入 + 精确 origin AS。)
- **pathsearch 按 origin_asn 排序 + 区间索引(关键性能)**：`pathsearch` 导出时**单线程 + preserve_insertion_order=true**
  按 `origin_asn` 排序写小分片(`PATHSEARCH_FILE_SIZE`=6MB)，meta 写 `files.pathsearch_origin`=每文件 `{f,lo,hi}`
  origin 区间(互不重叠)。前端 `pathsearchFilesForOrigin()`(db.js)据此让 **origin AS 搜索只 `read_parquet` 覆盖该 ASN 的
  那 1 个文件**(原来要扫全部 ~18 个/177MB → 现 ~7MB)；索引完整但无文件覆盖 = 该 origin 不存在, 直接空结果不发查询。
  **纯 AS_PATH(LIKE)搜索仍全表扫所有分片**(无法按子串裁剪)。单线程是必须的：多线程 COPY 写多文件不保证跨文件全局有序
  → origin 区间重叠 → 退化成多文件命中。
- 「浏览所有国家」入口已从侧栏移除；`countries.html` + `sitemap.xml` 仍在(给爬虫), SSG 落地页不受影响。
- **子网搜索**(`#ip` 框)：`prefixes`(ip_start 排序) `WHERE ip_start<=ip AND ip_end>=ip`，覆盖它的所有前缀。
  父子段也由 `prefixes` 范围自连接实时查。填了合法 IP 时**优先于**国家/path 等其它筛选。
- 主题：自动/亮/暗（`data-theme` + localStorage）；移动端有 `@media` 适配。
- badge/线路配色：电信蓝/联通红/移动绿/教育紫/科技橙/国际灰（`asn_ops` 驱动）。
- 抽屉显示**更大/更小段**（库内采集到的，可能不全，UI 已标注）。
- **DFZ 可见性**：`n_paths`(=观测到该前缀的 peer 数, 跨 rrc01+rrc06) 是可见度信号；export 出**按 family** 的
  `dfz_ref`/`dfz_ref_v6`(n_paths p90)。前端 `isLowVis`/`lowCutFor(v6)` = `n_paths < 0.2*dfz_ref[_v6]`(v6 自有阈值,
  其全网 peer 数远少)；控制栏「含低可见」默认**不勾**。
- 「关于」modal：数据来源/分析方法/免责（仅供学习研究 BGP）/数据更正 issue 链接。

## 不变量 / 常见坑（改动前必读）
- **不要重新引入"线路质量"评分**。CN2/GIA 从境外回程 BGP 分不出（GIA ⊂ CN2 同走 4809）。只看 AS_PATH。
- **`origin asn` 仅展示**，不得参与筛选/排序；命名永远叫 "origin asn"，不叫"回程 asn"。
- path 搜索是**连续相邻子序列**（`1299 23764 4809` ≠ `1299 4809`），不是"含且无序"。`--asn` 才是无序含任一。
- **ASN 名称/分组在 `config.json` 的 `asn_registry`**，不在代码里；改名加 ASN 改这里即可。
- 改 `mrt_collectors` 后**必须重新 `ingest`**。`focus_cities` 现仅作前端城市导航集(不再决定 carve 粒度), 改它不需重 ingest/导出。
- **geo 以合并后 geo 表为准**：export 用 `GeoIndexDuck.carve_cc` 把前缀切成各城市子段(**全球都到城市**,
  CN 用 ipdb / 国际用 GeoLite)，segs 预算成 **CIDR 串列表**进 `geo{,_v6}/<cc>`。超大聚合前缀(覆盖 geo 段 >`SEG_OVERLAP_CAP`)
  退化国家级单段防炸。
- **有效路由切段(关键)**：BGP 是最长前缀匹配——前缀的 AS_PATH 只对「**自身范围 − 更具体子段**」有效。export 先
  `_forest_duck` 建层状森林, 对每前缀 `_subtract(range, 子段holes)` 得有效范围, **再**按 geo 切城市。
- **export 会先 `shutil.rmtree(dist/data/parquet)`** 全部重写(文件名/计数每次变)。
- 前端改 `ipcollect/web/*` 后**必须 `npm run build`**(`ipc build` 会跑) 才进 `web/dist/`→`dist/`。**改 CHANGELOG 也要重 build**(内联)。
- `ipcollect.duckdb` 是中间态(跑完即弃, 已 gitignore)；`--reset` 清 obs/pathobs/prefix, **保留 geo/asn_dim/country_dim**。
  旧 `ipcollect.db`(SQLite) 已无用, 可删。

## 在不烧资源的前提下验证（重要）
- **JS**：`node --check dist/app.js`（或 `ipcollect/web/app.js`）。**CSS/HTML**：肉眼 + `ipc serve` 本地看。
- **Python 逻辑**：`./ipc <cmd> --help`、`python -c "from ipcollect import ..."`、对**只读查询**直接跑。
- **避免重下 400MB RIB**：库已存在就直接用；要试 ingest 逻辑可用 `--mrt-file cache/mrt/bview.*.gz`
  指向本地已下文件；或用 `--limit` 小批量。
- 改完**务必同步本文件**，并视情况更新 memory（见下）。

## 记忆
项目背景、设计取向、部署、"仅 agent 维护"等见
`~/.claude/projects/-home-aosc-test-ip-collect/memory/`（`MEMORY.md` 为索引）。

## 路线图（进行中）
**已完成**：全球全表 **v4+v6** PEER.AS(rrc01+rrc06 双采集点)，**DuckDB 工作库**(SQLite 退役)，纯静态可复现，
**DuckDB-WASM + Parquet**(v4/v6 两套)分发；geo 三轨合并(ipdb CN 城市 + GeoLite 国际城市 + rir 兜底)、**全球城市级** +
**AS organization**；i18n(zh/en) + SEO。详见 `docs/DUCKDB_V6_REFACTOR.md`。**无 CI**：全手动在本机跑, GitHub 仅托管源码。
**待办/可改进**：geo-import 的非重叠窗口去重(~分钟级)可优化；duckdb-wasm 可改 vendored 提升可镜像性;
v6 全表 carve 体量较大(692MB)可视情况收敛国际城市粒度。
