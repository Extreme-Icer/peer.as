// 全局响应式状态 (Svelte 5 runes)。各组件 import { S } 读写, 深层响应。
export const S = $state({
  meta: null,
  asnNames: {},            // 全量 ASN -> 名(APNIC autnums + 注册表覆盖); 开机 fetch asnames.json
  ready: false,            // DuckDB-WASM 就绪
  edge: 'cf',              // 'cf' | 'cn'：数据/wasm 宿主(configure 选定)；cn=正用中国优化 VPS
  lang: 'zh',
  theme: 'auto',           // auto | light | dark
  loading: true,
  msg: '',
  rows: [],                // 当前结果行
  mode: 'prompt',          // prompt | country | global | subnet
  filters: { cc: '', city: '', path: '', origin: '', ip: '', limit: 500, incllow: false },
  selectedPid: null,       // 选中行(高亮 + 展开本段)
  insight: null,           // { prefix, loc, origin_asn, n_paths, lowvis, paths:[{asns,peers,is_best}], sup:[], sub:[], loading }
  about: false,
  changelog: false,
  pathHelp: false,            // AS_PATH 语法帮助弹窗
  menu: false,                // 移动端下拉菜单开关
  sortKey: 'n_paths',
  sortDir: -1,
  detailW: 42,             // 详情栏宽度 %
})
