# 更新日志 / Changelog

PEER.AS 的功能更新记录。仅记录**面向用户的功能性变更**（新功能、可见行为变化）；
纯维护/重构/数据刷新不计入。最新在上。

Feature-level changelog for PEER.AS. Only **user-facing functional changes** are listed
(new features, visible behavior changes); pure maintenance/refactors/data refreshes are omitted. Newest first.

## 2026-06-04

- **新增：RPKI ROA 与 IRR 路由起源验证。** 每个前缀的 origin 现在会显示 **RPKI** 状态徽章（有效=绿 / 无效=红，
  无效细分「origin 未授权」与「比 maxLength 更具体」/ 未找到=中性，参照 bgp.he.net、bgp.tools）；前缀详情面板新增
  **IRR 路由对象**区块，列出该前缀在各 IRR 库（RIPE/APNIC/ARIN/AFRINIC/LACNIC…）登记的 route 对象并标注**权威/第三方**
  可信度。MOAS 多源前缀的每个 origin 各自显示状态。数据每日刷新，面板标注「数据截至」时间。
  **Added: RPKI ROA & IRR route-origin validation.** Each prefix's origin now shows an **RPKI** status badge (Valid=green /
  Invalid=red, split into «origin not authorized» vs «more specific than maxLength» / Not Found=neutral — following
  bgp.he.net & bgp.tools); the prefix detail panel gains an **IRR route objects** section listing the route objects
  registered for that prefix across IRR databases (RIPE/APNIC/ARIN/AFRINIC/LACNIC…) with an **authoritative/third-party**
  trust marker. Each origin of a MOAS prefix is validated independently. Data refreshes daily with an «as of» timestamp.
- **新增：IRR as-set 客户锥层级浏览。** 在搜索框输入 as-set 名（如 `AS-HURRICANE`、`AS2914:AS-GLOBAL`，或带来源
  `RIPE::AS-FOO`），左侧主区会以**可逐层展开的嵌套列表**显示它的成员——子 as-set 点一下就地展开下一层（懒加载、带环检测
  与深度上限），成员 ASN 可点击下钻。ASN 详情面板也新增「所属 as-set」反查（此 AS 被哪些 as-set 直接登记为成员）。
  **Added: IRR as-set customer-cone browser.** Type an as-set name (e.g. `AS-HURRICANE`, `AS2914:AS-GLOBAL`, or
  source-qualified `RIPE::AS-FOO`) and the main pane shows it as an **expandable nested list** — click a child as-set to
  expand the next level in place (lazy-loaded, with cycle detection and a depth cap); member ASNs drill down. The ASN
  detail panel also gains a «member of as-sets» reverse lookup (which as-sets directly list this AS).

## 2026-06-03

- **改进：浏览器标签/历史记录显示当前详情。** 打开某个前缀、ASN 或域名详情时，浏览器标签页标题（以及前进/后退
  历史记录里的条目）会随之变成正在查看的对象（如 `1.1.1.0/24 · PEER.AS`、`AS4538 CERNET · PEER.AS`），方便在
  历史记录里快速找回此前看过的页面。
  **Improved: browser tab/history shows the current detail.** When you open a prefix, ASN or domain detail, the
  browser tab title (and the entry in back/forward history) now reflects what you’re viewing (e.g.
  `1.1.1.0/24 · PEER.AS`, `AS4538 CERNET · PEER.AS`), making it easy to find a previously viewed page in history.

- **新增：DNS 解析页。** 在搜索框直接输入域名（如 `example.com`）即可解析 DNS：左侧列出全部记录——A / AAAA
  记录会逐条匹配到库内的 IP 前缀与 origin ASN（可点击下钻到前缀/ASN 详情），其余记录（NS / MX / TXT / SOA /
  CNAME / CAA 等）直接展示；右侧域名详情面板与 ASN 面板逻辑一致，自动尝试查询域名的 RDAP/WHOIS 注册信息
  （注册商、注册/到期时间、名称服务器、DNSSEC 等）。解析走 DNS over HTTPS（Cloudflare 1.1.1.1），纯前端、零后端。
  专属网址 `peer.as/dns/example.com` 可分享。
  **New: DNS lookup page.** Type a domain (e.g. `example.com`) right in the search box to resolve DNS: the left side
  lists all records — A / AAAA records are matched to the covering IP prefix and origin ASN in our dataset (click to
  drill into prefix/ASN detail), while other records (NS / MX / TXT / SOA / CNAME / CAA …) are shown directly; the
  right-side domain panel works like the ASN panel and auto-attempts the domain’s RDAP/WHOIS registration info
  (registrar, registration/expiry dates, nameservers, DNSSEC …). Resolution uses DNS over HTTPS (Cloudflare 1.1.1.1),
  fully client-side with no backend. Shareable URL: `peer.as/dns/example.com`.

## 2026-06-02

- **改进：英文界面国际化。** 英文界面下运营商（电信/联通/移动…→ Telecom/Unicom/Mobile…）、ASN 别名
  （如 CN2、CUII、CERNET）以及地名不再夹杂中文：日韩等城市过去会显示「英文省+中文市」，现在英文界面统一显示英文，
  无英文名的（如国内城市）回退到英文国家/地区名。
  **Improved: English UI internationalization.** In the English UI, operator categories (Telecom/Unicom/Mobile…),
  ASN aliases (e.g. CN2, CUII, CERNET) and place names no longer mix Chinese in: cities in Japan/Korea etc. used to
  show “English province + Chinese city”; the English UI now shows English throughout, falling back to the English
  country/region name where no English name exists (e.g. mainland-China cities).

- **新增：可分享的链接 / 浏览器前进后退。** 现在 ASN 与前缀详情都有独立网址，可直接打开或分享：
  `peer.as/4842`（ASN）、`peer.as/1.1.1.0/24`（前缀，IPv6 同理）会自动填入搜索框、搜索并展开对应详情；
  也支持传统的 `peer.as/?q=关键词` 搜索。在站内切换详情会更新网址，浏览器的前进/后退按钮可在浏览过的详情间穿梭。
  **New: shareable links / browser back-forward.** ASN and prefix details now have their own URLs you can open or share
  directly: `peer.as/4842` (ASN) and `peer.as/1.1.1.0/24` (prefix; IPv6 likewise) auto-fill the search box, search and
  open the matching detail; the classic `peer.as/?q=term` search also works. Navigating details updates the URL, and the
  browser back/forward buttons move through the details you’ve viewed.

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
