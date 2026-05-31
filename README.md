# PEER.AS — 回程 AS_PATH 采集 / 分析 / 静态看板

一套 CLI（`ipc`）：从 RIPE rrc00 的 MRT 全表做**静态分析**，入库口径 =
**境内(CN) 所有 AS_PATH 含焦点 ASN 的前缀**（不按城市过滤；城市以 ipdb 为准、展示时切段），
导出为**纯静态分片 JSON** 部署到看板，**按 AS_PATH 搜索**回程路由。

> 核心取向：BGP 数据里有参考价值的只有 **AS_PATH**——path 里有哪些 ASN + 它们的**顺序**。
> 不做任何"线路质量"评分（CN2 vs GIA 从境外 collector 的回程 BGP 根本分不出，GIA ⊂ CN2 同走 4809）。
> 搜索就是输入一段 ASN：**1 个 = path 含它；多个 = 按顺序相邻出现**
> （`1299 23764 4809` 与 `1299 4809` 是两回事）。
> MRT RIB 是 **per-peer** 的，每个 peer 的 AS_PATH 是一个「去往目标的去程」，multihome 前缀的
> 「等价路由」由此天然得到。`origin asn` 仅作展示参考，不参与排序。

## 数据流

```
geo     ipdb.txt  ──► geo 表(城市/省/运营商), ingest/build 据此定位
ingest  rrc00 RIB ──► prefix / pathobs / path_asn(倒排)   (境内 ∩ path含焦点ASN)
query   城市 + AS_PATH(含ASN/连续序列) + origin  多维筛选
insight 某前缀/IP 的 multihome 等价路由(各 peer 视角的去程 AS_PATH)
build   导出静态分片 JSON + 前端 ──► dist/  (部署到 CF Pages, 无服务器)
serve   本地 debug: 静态托管 dist/(看到的就是将部署的同一份产物)
```

## 安装 / 初始化

```bash
cd <repo>
./ipc init                 # 写默认 config.json + 建库
./ipc geo-import           # 导入 ipdb.txt(约 10s, 1.3M 行)
./ipc ingest               # 下载并解析 rrc00 最新 RIB(约 400MB)，按 境内(CN)+path含焦点ASN 入库(不按城市)
```

`ipc` 启动器会自动用同目录 `.venv`，数据/缓存都落在本目录（可用 `IPC_HOME` 覆盖）。
地理库默认取项目根的 `ipdb.txt`，可用 `IPC_IPDB_PATH` 环境变量指向别处。

## 配置（config.json）

`config.json` 已在 `.gitignore` 中（仅含本机配置，无密钥）；仓库提交的是 `config.example.json`。

```bash
./ipc config show
./ipc config set focus_asns 4809,23764,9929,4837,58807,58453,9808,4134,4538,7497  # path 含这些即入库
./ipc config set focus_cities 北京,上海,广州,深圳,杭州          # 展示时切到这些城市
```

关键项：
- `focus_asns`：纯 ASN 列表，**ingest 过滤器**——只保留 AS_PATH 含其中任一 ASN 的前缀。无任何质量含义。
  改了**需重新 `ingest`**。
- `focus_country_code`：ingest 时只保留该国前缀（默认 `CN`，空=不限）。`ingest --all-countries` 可临时不限。
- `focus_cities` / `focus_provinces`：**不影响入库**，只决定 build 把前缀切到哪些城市来展示。
  改了只需重新 `build`（不必 reingest）。
- `path_presets`：path 搜索的**预制下拉项**，每项 `{alias, path:[asns]}` 给一段连续 AS_PATH 起名
  （如 `电信CTGNet`=`[23764,4809]`）。面板/CLI 也可自行输入序列。
- `asn_registry`：ASN→`{name, op}` 注册表，**集中在 config.json 维护、不在代码里 hard code**，
  仅用于展示/下拉/着色（无评分）。覆盖五大骨干网 + 省级网 + 常见国际 transit。注：**58807 = 移动 CMIN2**。
  `bgp.set_registry()` 在 `config.load()` 时把它灌入 `bgp.ASN_REGISTRY/ASN_NAME`。

## 核心命令

```bash
# 筛前缀: 上海 + AS_PATH 出现连续 23764→4809
./ipc query --city 上海 --path "23764 4809"
./ipc query --city 上海 --asn 9929 --format csv --out sh.csv   # --asn=含任一(无序)

# 某前缀/IP 的 multihome 等价路由(各 peer 视角的去程 AS_PATH)
./ipc insight 101.226.0.0/16
./ipc insight 180.153.10.1

# 统计
./ipc stats

# 静态看板: 生成 dist/ (部署 CF Pages) + 本地 debug 托管
./ipc build                  # 产出 dist/ (静态前端 + 分片 JSON)
./ipc serve --rebuild        # 先 build 再本地托管, 浏览器开 http://127.0.0.1:8787/
```

## 实战提示（来自真实 rrc00 数据）

- **顺序很重要**：`--path "23764 4809"` 要求 23764 **紧接着** 4809（连续子串），与 `--asn 23764,4809`
  （path 含这两个即可，无序）语义不同。
- **不分 CN2/GIA**：GIA 是 CN2(4809) 的商业产品档，公网 BGP path 上看不出；真要区分只能 traceroute
  看 `59.43.x.x` 跳，不在本工具范围。

## Web 看板（纯静态 / Serverless）

看板是**纯静态**的：前端 (`ipcollect/web/{index.html,style.css,app.js}`) 只 `fetch ./data/*.json`，
**无服务器、无 `/api`**。`ipc build` 把数据库导出为分片 JSON 写入 `dist/`：

```
dist/
  index.html  style.css  app.js              # 独立前端, 便于维护
  data/
    index.json                # 统计 + 城市清单(含分片数) + ASN名称 + path_presets + focus
    ipindex.json              # 全部 IPv4 前缀 [start,end,pid,cid,prefix](子网搜索用)
    prefixes/<cid>-<p>.json   # 按城市分片的前缀; 每前缀内嵌去重 AS_PATH(供搜索+抽屉)
                              #   + 父子段 sup/sub(库内更大/更小段, build 时一次栈扫描预计算)
```

每个前缀**内嵌它的去重 AS_PATH**，所以 path 顺序搜索与 multihome 抽屉用同一份数据、无需二次请求。
抽屉里还显示该前缀的**更大段（覆盖它的母段）/ 更小段（更具体段）**，点击可跳到对应前缀（按需加载其城市
分片）。**注意：仅基于数据库已采集的前缀，并非全球路由表，父子段可能不全**——抽屉里也有同样提示。
面板**按需加载/搜索**：首屏只拉 `index.json`，选城市才拉它的前缀分片。大城市按 `PART_SIZE`(默认 2500)
**二次切分**，避免单文件超过 **CF Pages 25 MiB/文件**上限。

**部署 Cloudflare Pages**：把 `dist/` 作为输出目录（构建命令留空、无服务器）。本地 `ipc build` 后
`wrangler pages deploy dist`。账户与 token 通过环境变量提供（见 `.env.example`），不写进任何提交的文件。

## 定时（cron 示例）

```cron
# 每周一 3:09 重新 ingest 最新 RIB 并重建看板
9 3 * * 1   cd <repo> && ./ipc ingest --reset && ./ipc build >> cron.log 2>&1
```

## 数据表

`prefix`(焦点前缀+地理+origin) · `pathobs`(每peer去程 AS_PATH) · `path_asn`(ASN→前缀倒排) ·
`geo`(ipdb) · `meta`。

## 局限（务必知悉）

- AS_PATH 是以**公开 collector 各 peer 的去程**近似；真·某运营商视角受限于 rrc00 是否有该 peer。
  筛 `path 含某 ASN` 是最稳的维度（不依赖特定 peer），但顺序/相邻性受 collector 视角影响。
- 不做线路质量评分：CN2 vs GIA 等产品档从公网 BGP path 分不出（GIA ⊂ CN2 同走 4809）。
- City 级地理依赖 ipdb 精度。
