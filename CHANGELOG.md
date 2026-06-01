# 更新日志 / Changelog

PEER.AS 的功能更新记录。仅记录**面向用户的功能性变更**（新功能、可见行为变化）；
纯维护/重构/数据刷新不计入。最新在上。

Feature-level changelog for PEER.AS. Only **user-facing functional changes** are listed
(new features, visible behavior changes); pure maintenance/refactors/data refreshes are omitted. Newest first.

## 2026-06-01

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
