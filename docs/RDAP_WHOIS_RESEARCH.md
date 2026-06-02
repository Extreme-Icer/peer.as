# RDAP / WHOIS 集成调研（PEER.AS）

> 状态：调研完成、进入实现。本文件是该功能的设计契约，随实现更新。
> 关联：`AGENTS.md`（架构）、`docs/DUCKDB_V6_REFACTOR.md`（数据）。

## 0. 结论

**纯前端直连 RDAP 可行，零后端、零密钥**——与本项目「纯静态可复现站」架构契合。
我们已有的 prefix 详情面板（InsightDrawer）天然就是 inetnum/ASN 信息的载体，所以**不单独做
BGP/WHOIS 切换入口**，而是把 RDAP 信息**整合进现有详情面板**，并新增 ASN 详情视图。

## 1. 可行性核心：CORS 实测（ground truth, 2026-06）

浏览器直连 RDAP 成败只取决于 `Access-Control-Allow-Origin`。带 `Origin: https://peer.as` 实测：

| 服务器 | autnum GET | ip GET | CORS |
|---|---|---|---|
| rdap.org 重定向器 | 302 + Location | 302 + Location | `*` |
| APNIC `rdap.apnic.net` | 200 | 200 | `*`（历史缺失、**现已修复**）|
| RIPE `rdap.db.ripe.net` | 200 | 200 | `*`（**HEAD 不带、GET 带**，勿用 HEAD 探测）|
| ARIN `rdap.arin.net/registry` | 200 | 200 | `*` |
| LACNIC `rdap.lacnic.net/rdap` | 200 | 200 | `*` |
| AFRINIC `rdap.afrinic.net/rdap` | 200 | 200 | `*` |

**重定向 + CORS（关键、已验证不踩坑）**：rdap.org 返回 302 跳到对应 RIR，`fetch` 默认
`redirect:'follow'` 自动跟随，**CORS 在每一跳都检查**——rdap.org 与目标 RIR 两跳都带 `*`，跟随
不被拦。请求是简单 GET（`Accept` 属 CORS 安全头），**无预检 OPTIONS**。

## 2. 架构：构建期内置 IANA bootstrap，直连 RIR（rdap.org 兜底）

参考实现 `client.rdap.org` 是纯浏览器静态站、直连无代理。我们更进一步：**构建期内置 RFC 9224
IANA bootstrap 表**，前端自己做 bootstrap、直连目标 RIR。实测文件极小：

```
asn.json   4.4 KB   ipv4.json  5.6 KB   ipv6.json  1.5 KB   （dns.json 71KB，不做域名，不需要）
```

IP+ASN 共 ~12KB，随 `npm run build` 内置。优点：少一跳、不依赖 rdap.org 可用性/限流、路由透明。
bootstrap = 「按 AS 号/IP 区间二分查 base URL」，与 `bgp.js` 现有区间查找同构、可复用。
**兜底**：bootstrap 未命中或 RIR 报错 → fallback 到 `https://rdap.org/<type>/<object>`。

URL 形式：`<base>/autnum/<asn>`、`<base>/ip/<addr-or-cidr>`（ARIN base 末尾含 `/registry`）。

## 3. RDAP 响应 → 面板字段（已抓真实响应）

- **autnum（AS）**：`handle`、`name`、`country`、`status[]`、`startAutnum/endAutnum`、
  `events[]`（registration / last changed）、`remarks[]`、`entities[]`、`port43`。
- **ip（inetnum）**：`name`(netname)、`handle`(范围)、`country`、`type`(如 `ASSIGNED PORTABLE`)、
  `cidr0_cidrs[]`、`startAddress/endAddress`、`ipVersion`、`status[]`、`events[]`、`entities[]`。

补齐了我们缺的「注册维度」（持有者 / netname / abuse 联系人 / 分配类型 / 注册时间），与
我们的 BGP 实测（origin / AS_PATH / geo）强互补。

### jCard / vCard 结构（渲染关键）

`entity.vcardArray = ["vcard", [ [prop, paramsObj, valueType, value], ... ]]`，常见 prop：

| prop | 含义 | 取值要点 |
|---|---|---|
| `fn` | 全名/名称 | 字符串 |
| `kind` | individual / group / org | |
| `org` | 组织 | |
| `role` / `title` | 角色 / 头衔 | |
| `adr` | 地址 | 优先取 `paramsObj.label`（含真实地址、`\n` 分行）；否则 7 段数组 |
| `tel` | 电话 | `paramsObj.type` = voice/fax |
| `email` | 邮箱 | 可重复，`paramsObj.pref` 表首选 |
| `version` | 跳过 | |

entity 可**递归嵌套**（`entity.entities[]`）。`roles[]` = administrative / technical / **abuse** / registrant 等。

## 4. 前端集成设计（本期实现方向）

**不做 BGP/WHOIS 顶层切换**——焦点本就是 ASN 与 prefix(inetnum)，已有详情面板承载。

### 4.1 触发
- 精确输入框输入 **ASN**（用户想看该 AS 的全部路由）→ **自动展开右侧详情面板**，显示该 ASN 的
  WHOIS + 上下游邻居（**不画路由图**——路由图是 per-prefix 的，整个 ASN 的路由图无实际意义，
  对标 he.net 那种亦无意义）。
- 点击结果行 / `AsnTag` → 打开对应 prefix / ASN 详情（沿用现有 + 新增 ASN 视图）。

### 4.2 详情面板「前进 / 后退」导航（新增）
- 详情面板维护一个**导航栈**（history），元素为 `{kind:'prefix'|'asn', id}`。
- 顶部加 ← / → 按钮，用户可在已访问的 ASN 页与 prefix 页之间来回。
- 在 prefix 页点 origin ASN → push 一条 asn 记录；在 asn 页点某前缀 → push prefix 记录。

### 4.3 关闭键的「先返回再关闭」语义（新增、符合直觉）
- 当**输入框是 ASN**（用户的主体是这个 ASN）而面板当前显示的是某 **prefix** 时：
  点关闭 **不真正关闭**，而是**导航回该 ASN 信息页**；**再点一次**才真正关闭面板。
- 实现：关闭按钮先看导航栈/上下文——若当前是 prefix 且存在「主体 ASN」上下文，则 pop 回 ASN；
  否则 closeInsight。

### 4.4 WHOIS 式扁平渲染（核心观感）
用户已习惯传统 whois 的 `Key: Value` 扁平观感，而非 jCard 的强层级：
- **大部分一行一个 `Key: Value`**；常见 key 左侧加 FA 图标（不认识的用默认图标）。
  - 字段→图标示意：netname/handle=tag、holder/org=building、country=flag/globe、
    abuse email=shield/at、tel=phone、address=location、registration/changed=clock、
    status=circle-check、type=layer、AS number=hashtag。
- **只有嵌套 entity 才右缩进一行**；entity **默认收起成一行**（角色 + fn/handle），
  点击展开其 vcard 的 key-value（再缩进）。递归 entity 同理。
- 整体视觉接近过往 ASCII whois：信息密集、等宽感、层级浅。

### 4.5 风格 / 适配（硬约束）
- 沿用 console 暗色设计 + **系统默认字体**（勿引自定义 web 字体，中文糊）+ FA 图标 + teal/amber。
- **暗/亮/auto** 主题（`data-theme`）、**移动端** `@media` 适配、**i18n**（zh/en，`STRINGS`/`t()`）全部覆盖。
- 用 claude frontend-design skill 指导设计。

## 5. 风险与坑

1. **中国访问（最重要）**：RDAP 与 rdap.org 均在境外，`cn.peer.as` 境内用户直连可能慢/不稳。
   **缓解**：cn.peer.as 的 Caddy 加 `/rdap/*` 反代到 RIR（同源、优化线路），前端按 `S.edge==='cn'`
   切到本地反代。与现有「数据按 geo 分流」一致。本期可先不做，留接口。
2. **RIPE HEAD 不带 CORS**：只用 GET。
3. **限流**：RIR 对 RDAP 限速；客户端直连 = 按访客 IP 分摊、天然分布式，比中心代理更不易被限。
   加**内存 + sessionStorage 缓存**（key = `autnum:<n>` / `ip:<cidr>`）进一步降频。
4. **SW / CSP**：实测 `public/sw.js` 放行跨源、`index.html` 无 CSP，无需改动即可跨源 fetch。
   若后续加 CSP 须 allowlist RDAP 域名。
5. **jCard 解析**：封装 helper 统一拍平为 `{label, value, icon}[]` + 嵌套 entity 树。

## 6. Mock 数据

`ipcollect/web/mock/rdap/{autnum,ip}/*.json`（真实抓取，多 RIR + v4/v6 + 中国回程 ASN），供前端
开发/调试离线渲染。**仅开发用，勿打进生产 bundle**（放 `mock/` 不在 `src/`、不被 import 即可）。
覆盖：autnum 4809/4134/9929/58807/23764/4837(APNIC) · 1299/3333(RIPE) · 174/13335/6939(ARIN) ·
27947(LACNIC) · 33771(AFRINIC)；ip v4/v6 跨 RIR 含 202.97/16、223.5.5/24、240e::/20 等。

## 7. 改动文件（预估）

- 新增：`web/src/lib/rdap.js`（bootstrap + fetch + jCard 拍平 + 缓存 + rdap.org 兜底）、
  构建期内置 `web/src/lib/rdap-bootstrap.*`（或 `public/` + fetch）、WHOIS 渲染组件
  （如 `WhoisView.svelte` / `AsnDetail.svelte`，或并入 InsightDrawer）。
- 改动：`store.svelte.js`（导航栈 / selectedAsn / RDAP 缓存）、`InsightDrawer.svelte`（前进后退 +
  关闭语义 + RDAP 区块）、`queries.js`（`showAsn` + ASN 上下游聚合）、`Topbar/输入解析`（ASN 自动开面板）、
  `AsnTag.svelte`（可点开 ASN）、`i18n.js`（文案）、`icons.js`（新图标）。
- 纯前端：`./ipc build` + `scripts/deploy.sh`，**无需重 ingest/export 数据**。
- 上线时按 `AGENTS.md` 在 `CHANGELOG.md` 顶部加双语条目。
