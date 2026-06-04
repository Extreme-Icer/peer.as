# RPKI/ROA + IRR(route/as-set)接入调研与设计

> 面向 agent 的设计文档。读者无先验上下文。结论：三层数据都能在**导出期(`parquet_export.py`)
> 用 DuckDB 预计算成静态列/parquet**，前端零后端按 parquet 查询 —— 契合本项目「全表预计算 + 静态可复现」范式。
> 参照 bgp.he.net / bgp.tools 的展示策略。**Phase 1(RPKI)+ Phase 2(IRR route)已实现**；Phase 3(as-set 树)待做。

## 0. 三层数据：语义、可信度、状态机（设计核心）

| 层 | 判定语义 | 状态 | 可信度 | 全球规模 |
|---|---|---|---|---|
| **RPKI ROA** | covering + maxLength + origin（RFC 6811） | Valid / Invalid(ASN) / Invalid(length) / NotFound | 高（RIR 加密签名） | ~930k VRP 行 |
| **IRR route** | **精确前缀** + origin 完全匹配（无 maxLength 覆盖语义） | present(列出来源库) / mismatch / not-found | 中（第三方库任何人可注册） | ~2–3M 对象 |
| **IRR as-set** | 递归成员树（登记的「客户锥」意图） | 可展开层级 + 反查 member-of | 中（声明意图 ≠ 观测拓扑） | 数十万对象，单个可展开到 10万+ ASN |

**铁律**：三者信任级别/语义不同，必须**分开呈现、分开标注可信度**，不可合并成单一「valid」位（bgp.tools 的核心 UX）。
- RPKI 有真正的 **Invalid**（覆盖了但 origin/长度不符）→ 红色告警；**NotFound 是中性非错误**（最常见 UX 坑就是把它当错误）。
  he.net 把 Invalid 拆成 `INVALID_ASN` / `INVALID_LENGTH` 两个原因，比扁平 Invalid 更有用 —— 本项目照搬。
- IRR **没有 Invalid**，只有「有没有登记」+ 可选「origin 对不上(mismatch)」→ 中性/黄色，且**必须标来源库 + 权威/非权威**。
- as-set 是**登记意图**，非观测拓扑（要与 CAIDA 的「观测客户锥」区分；本项目无 CAIDA 数据，只做登记态，UI 标 registered）。

## 1. RPKI ROV 算法（RFC 6811，已实现于 `ipcollect/rpki.py`）

VRP = `(prefix, maxLength, origin-ASN)`。对一条 BGP 路由 `(prefix, origin)`：
- **Covered**：存在 VRP，其前缀长度 ≤ 路由前缀长度，且前若干 bit 相同（路由等于或更具体）。等价数值判定：`vrp.ip_start ≤ route.ip_start AND vrp.ip_end ≥ route.ip_end`。
- **Matched**：Covered **且** `route.plen ≤ vrp.maxLength` **且** `route.origin == vrp.asn`。
- **状态**：有任一 Matched → **Valid**；无 Matched 但有 Covered → **Invalid**；无 Covered → **NotFound**。
- **Invalid 原因细分**（he.net 风格，本项目采用）：覆盖 VRP 中存在 `asn==origin` 者（仅长度不符）→ `invalid_len`；否则 → `invalid_asn`。
- **优先级 Valid > Invalid > NotFound**：单个 Matched 即 Valid，无论多少其它仅 Covered 的 VRP。**不可在首个 Covered 就短路判 Invalid**，要扫完所有覆盖 VRP。

数据源（统一 schema `{asn, prefix, maxLength, ta}`，一个解析器两站通吃）：
- peeras：`https://rpki.cloudflare.com/rpki.json`（rpki-client 产出，单 GET，~930k 行，含 `metadata.buildtime`）。
- dn42：`https://dn42.burble.com/roa/dn42_roa_46.json`（同 schema，~1.5k 行）。

## 2. IRR route（已实现于 `ipcollect/irr.py`）

`route:`/`route6:` 对象 = 前缀 + `origin:`。**精确前缀 + 精确 origin** 匹配（与 RPKI 不同：无 maxLength，更具体前缀需各自的 route 对象）。
- present：该精确前缀存在 origin 相符的 route 对象（聚合所有来源库）。
- mismatch：该精确前缀有 route 对象，但 origin 全不符（登记给了别的 AS）。
- not-found：该精确前缀无任何 route 对象。

多来源库 + 信任问题：第三方库（RADB/NTTCOM/LEVEL3…）任何人可注册 → 可信度低于权威 RIR 库（RIPE/APNIC/ARIN/AFRINIC/LACNIC）。
故**每条对象标来源库 + 权威/非权威**（bgp.tools 的 "unauthenticated IRR source" 半勾思路）。

批量 dump（离线管线，非 per-prefix whois）：
- RIPE：`https://ftp.ripe.net/ripe/dbase/split/ripe.db.route{,6}.gz` + `ripe-nonauth.db.route{,6}.gz`
- APNIC：`https://ftp.apnic.net/pub/apnic/whois/apnic.db.route{,6}.gz`
- ARIN：`https://ftp.arin.net/pub/rr/arin.db.gz`（route/route6 混在一个 dump）
- AFRINIC：`https://ftp.afrinic.net/pub/dbase/afrinic.db.gz`、LACNIC：`https://irr.lacnic.net/lacnic.db.gz`
- 第三方：`https://ftp.radb.net/radb/dbase/radb.db.gz`(~25MB) 等。合计 ~60–70MB 压缩。
- RPSL 格式：空行分隔的 `attr: value` 块；取 `route`/`route6`(前缀)、`origin`(去 `AS` 前缀)、`source`(库名)。
- dn42：registry git 仓即 IRR，`data/route{,6}/<prefix_用_替/>`，`registry.py` 已解析 RPSL。

## 3. IRR as-set（Phase 3，待实现）

`as-set:` 的 `members:` 可含 **ASN 和其它 as-set**（递归图）。用途 = 声明客户锥（生成前缀过滤，bgpq4）。命名 `AS-FOO` / 层级 `AS2914:AS-GLOBAL`（冒号表所有权）。
- **绝不预展开**：最大锥可达 10万+ ASN（AS-HURRICANE ~23k、部分 peers 集 ~100k）。
- **静态站做法**：只存**一级成员边** `(SOURCE::set → member, kind)` + 反查 `member_of` 索引 + 可选预算 `cone_size` 标量；
  前端点击逐层懒查（DuckDB-WASM 一条 `WHERE set_key=?`），祖先路径 Set 做**环检测**，深度上限 ≥16。
- 键一律 `SOURCE::NAME` 防跨库重名；展示「正向(含哪些成员)」与「反向(此 AS 属于哪些 as-set)」两视图。
- 数据：`ripe.db.as-set.gz` / `radb.db.gz` 内混；dn42 `data/as-set/<NAME>`（本地 88 个，28 个有嵌套）。

## 4. 本项目落点（关键文件）

- **采集**：`ipcollect/rpki.py`(VRP)、`ipcollect/irr.py`(route)。下载→解析→写 `cache/{rpki,irr}/*.csv` + `meta.json`(含 `as_of` 时间戳)。
  CLI：`ipc rpki-import` / `ipc irr-import`（亦可由 export 自动按需刷新）。
- **导出**(`parquet_export.py`)：
  - `route_origin`(pid,family,ip_start,ip_end,plen,origin) = 每 (前缀,origin) 对（含 MOAS 次要 origin，取自 pathobs）。
  - `rpki.classify` → `rpki_status(pid,origin,rpki UTINYINT)`：vrp range join（`ip_start/ip_end` UHUGEINT 已在 prefix 表，免位运算）。
  - `irr.classify` → `irr_status(pid,origin,irr UTINYINT)`：irr_route 精确前缀 join。
  - **rpki/irr 列**贴到 `prefixes{,_v6}`(代表 origin)、`pathsearch{,_v6}`(每 origin 行)、`geo{,_v6}`(代表 origin)；
    MOAS 数组 `origin_rpki`(与 `origin_asns` 对齐) 进 `prefixes` / `prefix_origins`。
  - **IRR 对象数据集** `irr{,_v6}/`：仅「精确前缀 = 库内已观测前缀」的 route 对象，每 (pid,origin) 一行 + `sources` 数组；v4 建 `irr_ip` 区间索引（同 prefixes_ip），v6 读全部。
  - `meta.json` 能力位 `has_rpki`/`has_irr` + `rpki_as_of`/`irr_as_of`/计数。旧前端缺列自动降级（同 `has_moas` 惯例）。
- **Profile**(`profile.py` + `web/src/lib/site.js`)：开关 `rpki`/`irr`，两站默认 on（数据缺失时 `has_*`=false 自动 no-op）。
- **前端**：
  - `web/src/components/OriginStatus.svelte`：给定 `{rpki, irr}` 码渲染徽章（Valid 绿 / Invalid 红(分 ASN/length) / NotFound 中性 / IRR present/mismatch）。
  - 列表 `Results.svelte` origin 列：RPKI 徽章；详情 `InsightDrawer.svelte`：origin pill + MOAS 每 origin 徽章 + **IRR 区块**（列 route 对象，标来源库 + 权威/非权威）。
  - 列选择门控在 `queries.js`（`has_rpki`/`has_irr` 决定是否 SELECT 该列）。
- **部署**：`scripts/deploy.sh --data` 在 ingest 后、export 前调 rpki/irr import；缓存进 `cache/`，daily-refresh 自动带上。

## 5. 状态码约定（前后端一致）

- `rpki`(UTINYINT)：`0/NULL`=NotFound、`1`=Valid、`2`=Invalid(ASN 不符)、`3`=Invalid(长度超 maxLength)。
- `irr`(UTINYINT)：`0/NULL`=not-found、`1`=present(有相符 origin 的 route 对象)、`2`=mismatch(有对象但 origin 全不符)。

## 6. 取舍 / 坑
- as-set 绝不可预展开（10万+ ASN）→ 一级边 + 懒查 + 环检测（Phase 3）。
- IRR 可信度低：必须标来源库 + 权威/非权威，否则误导用户。
- RPKI range join：route_origin × vrp 的双不等式 join（IEJoin），按 family 等值分区；v4 ~1.3M×~0.4M，DuckDB 数十秒级。
- 新鲜度：UI 显式标「as of <buildtime>」，避免运营商修了 ROA 后旧 Invalid 滞留误导。
- dn42 白送：registry = IRR + ROA + as-set 三合一，`registry.py` 已解析 RPSL。
