// 全局响应式状态 (Svelte 5 runes)。各组件 import { S } 读写, 深层响应。
export const S = $state({
  meta: null,
  asnNames: {},            // 全量 ASN -> 名(APNIC autnums + 注册表覆盖); 开机 fetch asnames.json
  asnOrg: {},              // ASN -> organization(GeoLite2-ASN); 开机 fetch asnorg.json
  ready: false,            // DuckDB-WASM 就绪
  edge: 'cf',              // 'cf' | 'cn'：数据/wasm 宿主(configure 选定)；cn=正用中国优化 VPS
  lang: 'zh',
  theme: 'auto',           // auto | light | dark
  loading: true,
  msg: '',
  rows: [],                // 当前结果行
  mode: 'prompt',          // prompt | country | global | subnet | dns
  // DNS 解析视图载荷(mode==='dns' 时主内容区改渲染 DnsView): { domain, loading, error, status, a:[], aaaa:[], others:[] }
  // a/aaaa 行已富集前缀+origin asn(由 queries.runDns 查 prefixes 得到); others = 其它记录类型分组。
  dns: null,
  filters: { cc: '', city: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' },
  selectedPid: null,       // 选中行(高亮 + 展开本段)
  // ── 右侧详情面板 ──────────────────────────────────────────────
  // detailKind: 当前面板视图 'prefix' | 'asn' | 'domain' | null(关闭)。prefix 载荷在 insight, asn 在 asnView, domain 在 domainView。
  detailKind: null,
  insight: null,           // { prefix, loc, origin_asn, n_paths, lowvis, paths:[{asns,peers,is_best}], sup:[], sub:[], loading }
  asnView: null,           // { asn, name, loading, error, count4, count6, prefixes:[], upstreams:[{asn,n}], neigh:null|{up,down,scanned} }
  domainView: null,        // { domain } —— 域名详情面板载荷; WHOIS/RDAP 由 Whois.svelte(kind='domain') 自取。
  // 主体上下文: 精确框是 ASN/域名 时 = {kind:'asn'|'domain', id}; 用于「关闭子页时先返回主体」语义。其它输入则 null。
  subject: null,
  // 面板前进/后退 = 浏览器历史驱动(pushState/popstate)。idx=当前历史序号, max=已达最大序号(决定能否前进)。
  nav: { idx: 0, max: 0 },
  about: false,
  changelog: false,
  pathHelp: false,            // AS_PATH 语法帮助弹窗
  menu: false,                // 移动端下拉菜单开关
  sortKey: 'n_paths',
  sortDir: -1,
  detailW: 42,             // 详情栏宽度 %
})
