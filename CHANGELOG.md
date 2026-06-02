# 更新日志 / Changelog

PEER.AS 的功能更新记录。仅记录**面向用户的功能性变更**（新功能、可见行为变化）；
纯维护/重构/数据刷新不计入。最新在上。

Feature-level changelog for PEER.AS. Only **user-facing functional changes** are listed
(new features, visible behavior changes); pure maintenance/refactors/data refreshes are omitted. Newest first.

## 2026-06-02

- **新增：WHOIS / 注册信息（RDAP）+ ASN 详情面板。** 前缀详情面板新增「WHOIS / 注册信息」区块（持有者、
  netname、分配类型、abuse 联系人、注册/变更时间），浏览器直连各 RIR RDAP 实时获取；在精确框输入一个
  ASN（如 `AS4809`）会自动展开该 ASN 的详情面板——含 WHOIS、通告的前缀、观测到的上游，并可一键全表扫描完整
  上下游邻居。详情面板新增前进/后退导航，可在 ASN 与前缀之间来回；点击前缀详情里的 origin ASN 即可跳到它的
  ASN 页。WHOIS 以传统扁平风格呈现（一行一项、常见字段带图标，嵌套联系人可点击展开）。
  **New: WHOIS / registration (RDAP) + ASN detail panel.** The prefix panel now has a “WHOIS / registration”
  section (holder, netname, allocation type, abuse contact, registration/change dates), fetched live straight
  from the RIRs’ RDAP in your browser. Typing an ASN (e.g. `AS4809`) into the precise box auto-opens that ASN’s
  detail panel — WHOIS, originated prefixes, observed upstreams, with an on-demand full-table scan for complete
  up/downstream neighbors. The detail panel gains back/forward navigation to move between ASN and prefix views;
  click the origin ASN in a prefix panel to jump to its ASN page. WHOIS is shown in a flat, classic style
  (one line per field, icons on common keys, nested contacts expand on click).

- **新增：IPv6 支持。** 现可搜索 IPv6 地址 / CIDR（如 `2001:db8::/32`）、按国家浏览 v6 前缀、查 v6 父子段;
  v4 与 v6 结果在国家/全表搜索里一并呈现。
  **New: IPv6 support.** Search IPv6 addresses/CIDRs (e.g. `2001:db8::/32`), browse v6 prefixes by country,
  and explore v6 parent/child segments; v4 and v6 results show together in country/global search.

- **新增：全球城市级地理 + AS organization。** 国际前缀也定位到城市（GeoLite，国内仍用更准的城市库）;
  ASN 悬停显示其 organization 全名。
  **New: worldwide city-level geo + AS organization.** International prefixes now resolve to city (GeoLite;
  CN still uses a more accurate DB); hovering an ASN shows its full organization name.

- **改进：双采集点。** 数据源改为 RIPE RIS `rrc01`（伦敦）+ `rrc06`（东京）两点合并，路径观测更全面。
  **Improved: dual collectors.** Data now merges RIPE RIS `rrc01` (London) + `rrc06` (Tokyo) for broader path coverage.

## 2026-06-01

- **新增：AS_PATH 通配与排除搜索。** AS_PATH 框现支持 `*`（任意间隔）、`?`（正好一跳）与 `!N`/`-N`（排除某 ASN）；
  搜索框旁的 `?` 图标可打开语法说明弹窗。
  **New: AS_PATH wildcard & exclusion search.** The AS_PATH box now supports `*` (any gap), `?` (exactly one hop)
  and `!N`/`-N` (exclude an ASN); a `?` icon beside the box opens a syntax help dialog.

- **改进：过滤默认路由 `0.0.0.0/0`。** 入库与数据集中不再包含默认路由（它不代表任何具体网络的可达性，
  仅会污染搜索与统计）。
  **Improved: filter the default route `0.0.0.0/0`.** The default route is no longer ingested or included in the
  dataset (it doesn't represent any specific network's reachability and only pollutes search/stats).

- **新增：按 AS 名称搜索。** 主搜索框现在支持直接输入 ASN 名称（中文或英文，如「阿里云」「Cloudflare」），
  自动反推匹配的 origin ASN（可命中多个），并按这些 origin 过滤前缀。
  **New: search by AS name.** The main search box now accepts an ASN name (Chinese or English, e.g. "Cloudflare"),
  automatically resolving it to the matching origin ASN(s) — multiple matches are all included — and filters prefixes by them.

- **改进：路由图绘制 origin → 上游 → Tier-1 的完整链路。** 修复了经多个 Tier-1 转接时被截断、
  以及直连 Tier-1（含 HE / AS6939）未被画出的问题；路径末端恒为 Tier-1，多 Tier-1 转接完整呈现。
  **Improved: route graph now draws the full origin → upstream → Tier-1 chain.** Fixed truncation when a path
  transits multiple Tier-1s, and direct Tier-1 peers (incl. HE / AS6939) not being drawn; the chain always
  terminates at a Tier-1, and multi-Tier-1 transit is shown in full.

- **改进：移动端布局。** 移除浮动侧栏，改为顶部品牌栏 + 右侧下拉菜单（统计、链接、语言/主题/关于/更新日志）。
  **Improved: mobile layout.** Replaced the floating sidebar with a top brand bar + right-side dropdown menu
  (stats, links, language/theme/about/changelog).

- **新增：更新日志。** 网站与仓库均可查看本更新日志。
  **New: changelog.** This changelog is viewable both on the site and in the repository.
