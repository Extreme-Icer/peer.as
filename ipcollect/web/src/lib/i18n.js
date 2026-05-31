import { S } from './store.svelte.js'

export const STRINGS = {
  zh: {
    page_title: 'PEER.AS — BGP / IP / ASN 信息洞察',
    page_desc: 'PEER.AS — 探索全球 BGP 路由：IP 前缀、ASN、AS_PATH、origin 与对端。纯静态、可复现的 BGP looking glass 与 IP/ASN 信息工具。',
    overview: '概览', t_prefix: '前缀', t_paths: 'path 观测',
    t_country: '国家/地区', t_gen: '生成', legend: '图例', best: '最优路径（流量实际走）',
    lowvis: '疑未入 DFZ', tier1: 'Tier-1 骨干', search: '搜索',
    ph_ip: '如 203.0.113.5', ph_cc: '国家/地区（空=全表搜索）', ph_city: '城市（空=全国）',
    ph_path: 'AS_PATH 连续序列, 如 23764 4809（回车搜索）', ph_origin: '如 4538', ph_limit: '上限',
    incllow: '含低可见', subnet: '子网', country: '国家', city: '城市', path: 'AS_PATH', origin: 'origin AS',
    clear: '清空',
    pick_country: '选一个<b>国家/地区</b>浏览；或输入 <b>AS_PATH</b> / <b>origin AS</b> 做<b>全表搜索</b>；或按 <b>IP</b> 子网搜索。',
    loading: '正在加载查询引擎 (DuckDB-WASM)…', querying: '查询中…',
    searching_global: '全表 AS_PATH 搜索中（扫描全表，可能较慢）…',
    col_prefix: '前缀', col_origin: 'origin asn', col_loc: '位置', col_path: '#path',
    col_seg: '本段', col_match: '匹配 path', no_results: '无结果', no_data_cc: '该国家暂无数据',
    no_cover: '库内无前缀覆盖该 IP', query_failed: '查询失败',
    paths_all: '全部去重路径', sup: '更大段（母段）', sub: '更小段（更具体段）', none_in_db: '库内无',
    graph_title: '路由图 · origin → 上游 / Tier-1', segs_title: '本前缀在此地实际路由的子段（CIDR）',
    rel_note: '仅基于已采集前缀（全球 v4 全表），父子段以数值范围实时查得。',
    peers: 'peer 观测', distinct: '去重路径', subnet_done: '覆盖前缀', global: '全表',
  },
  en: {
    page_title: 'PEER.AS — BGP, IP & ASN Insights',
    page_desc: 'PEER.AS — explore global BGP routing, IP prefixes, ASNs, AS_PATH, origins and peering. A fast, static, reproducible BGP looking glass and IP/ASN intelligence tool.',
    overview: 'Overview', t_prefix: 'Prefixes',
    t_paths: 'Path obs', t_country: 'Countries', t_gen: 'Generated', legend: 'Legend',
    best: 'Best path (traffic follows)', lowvis: 'likely not in DFZ', tier1: 'Tier-1 backbone', search: 'Search',
    ph_ip: 'e.g. 203.0.113.5', ph_cc: 'Country/region (empty = global)', ph_city: 'City (empty = all)',
    ph_path: 'AS_PATH seq, e.g. 23764 4809 (Enter to search)', ph_origin: 'e.g. 4538', ph_limit: 'limit',
    incllow: 'incl. low-vis', subnet: 'Subnet', country: 'Country', city: 'City', path: 'AS_PATH', origin: 'origin AS',
    clear: 'Clear',
    pick_country: 'Pick a <b>country/region</b>, or type an <b>AS_PATH</b> / <b>origin AS</b> for a <b>global search</b>, or <b>subnet search</b> by IP.',
    loading: 'Loading query engine (DuckDB-WASM)…', querying: 'Querying…',
    searching_global: 'Global AS_PATH search (full-table scan, may be slow)…',
    col_prefix: 'Prefix', col_origin: 'origin asn', col_loc: 'Location', col_path: '#path',
    col_seg: 'Segs', col_match: 'matched path', no_results: 'no results', no_data_cc: 'No data for this country',
    no_cover: 'no prefix covers this IP', query_failed: 'Query failed',
    paths_all: 'All distinct paths', sup: 'Larger (covering)', sub: 'More specific', none_in_db: 'none in DB',
    graph_title: 'Route graph · origin → upstream / Tier-1', segs_title: 'Segments actually routed here (CIDR)',
    rel_note: 'Based on collected prefixes (global IPv4); parent/child found live by numeric range.',
    peers: 'peer obs', distinct: 'distinct paths', subnet_done: 'covering prefixes', global: 'global',
  },
}

export function t(k) {
  const s = STRINGS[S.lang] || STRINGS.zh
  return s[k] ?? STRINGS.zh[k] ?? k
}
