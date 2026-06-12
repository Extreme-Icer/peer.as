// IP → 地理坐标解析(可插拔, 多数据源)。供全球路由跟踪把每一跳 / 目标 IP 落到地球上。
//
// 内置数据源(setGeoSource 切换, 默认 nexttrace):
//   · 'duckdb'    —— 本项目自有数据: cc/city/asn/prefix 来自 DuckDB geo 数据集(queries.geoEnrich,
//                    异步), 坐标用「真实探测点城市坐标表」(trace-probes 注入)→ 国家质心 CC_CENTROID。
//                    坐标只到城市/国家级(DuckDB 无逐 IP 经纬)。逐 IP 经 resolveGeo 客户端解析。
//   · 'nexttrace' —— 逐 IP 精确经纬度, 但**不在客户端直接查 NextTrace**(免 token、免限流):改由
//                    peer-as-nexttrace worker 拿 globalping measureId 取回 measurement + 用无限额
//                    token 批量加 geo 返回。故此源下 geo 随 measurement 一起到达(d.geo[ip]),
//                    `globalping.getMeasurement` 经 measurementUrl() 走 worker, buildHops 直接读 d.geo,
//                    不调 resolveGeo。仅当 worker 没给某 IP geo 时, 该跳无坐标(不落地球)。
//
// setGeoResolver(fn) 仍可整体换成任意自定义解析器(覆盖 duckdb 源)。

import { ccLatLon } from './geo.js'
import { geoEnrich } from './queries.js'
import { S } from './store.svelte.js'
import { placeLabel } from './bgp.js'

// (cc, city) -> {lat,lon} | null。由 trace-probes 用真实 globalping 探测点坐标填充(城市级)。
let cityCoordFn = null
export function setCityCoordProvider(fn) { cityCoordFn = fn }

// 解析缓存(ip -> Promise): 同一 IP 多跳并发只查一次。切换数据源 / token 时清空(下次按新源重查)。
const cache = new Map()
export function clearGeoCache() { cache.clear() }

// ── 数据源 1: DuckDB geo + 坐标补全 ───────────────────────────────────────────
async function duckdbResolve(ip) {
  const m = await geoEnrich(ip)
  if (!m) return null
  const cc = m.cc && m.cc !== 'ZZ' ? m.cc : ''
  let lat = null, lon = null, source = 'none'
  if (cc && m.city && cityCoordFn) { const c = cityCoordFn(cc, m.city); if (c) { lat = c.lat; lon = c.lon; source = 'city' } }
  if (lat == null && cc) { const c = ccLatLon(cc); lat = c.lat; lon = c.lon; source = 'centroid' }
  return { ip, cc, city: m.city || '', province: m.province || '', asn: m.asn ?? null, prefix: m.prefix ?? null, lat, lon, source, place: placeLabel(m.province, m.city, cc) || '' }
}

// ── 数据源 2: NextTrace(经 peer-as-nexttrace worker, 免 token)─────────────────
// 客户端不直接查 NextTrace; geo 由 worker 随 measurement 一起返回(见文件头 + worker 源码)。
// measurementUrl(id): nexttrace 源 → 走 worker(?id=&lang=, 响应含 d.geo); duckdb 源 → 返回 null
// (调用方直连 globalping, geo 由客户端 resolveGeo 解析)。
const GEO_WORKER = 'https://peer-as-nexttrace.archeb.workers.dev/'
export function measurementUrl(id) {
  if (activeSource !== 'nexttrace') return null
  return GEO_WORKER + '?id=' + encodeURIComponent(id) + '&lang=' + (S?.lang === 'zh' ? 'zh' : 'en')
}

// 批量预热缓存(仅 duckdb 源, 客户端逐 IP 解析时并行填充; nexttrace 源 geo 随结果到达, 无需预热)。
export function resolveGeoBatch(ips) {
  if (activeSource === 'nexttrace') return   // geo 随 measurement 返回, 不在此预热
  const uniq = [...new Set((ips || []).map(s => (s || '').trim()))].filter(s => s && isIpLiteral(s) && !cache.has(s))
  for (const ip of uniq) resolveGeo(ip)
}

// ── 数据源注册 + 选择 ─────────────────────────────────────────────────────────
// nexttrace 源的逐 IP 解析理论上不会被调用(geo 随 measurement 到达); 万一被调到, 退化为 duckdb。
const SOURCES = { duckdb: duckdbResolve, nexttrace: duckdbResolve }
export function geoSources() { return Object.keys(SOURCES) }
let activeSource = 'nexttrace'   // 默认 NextTrace(无 token 自动回退 duckdb)
export function setGeoSource(name) { if (SOURCES[name] && name !== activeSource) { activeSource = name; cache.clear() } }
export function getGeoSource() { return activeSource }

// 整体自定义解析器(覆盖数据源选择): ip -> Promise<GeoResult|null>。
let customResolver = null
export function setGeoResolver(fn) { customResolver = fn || null; cache.clear() }

// 只对 IP 字面量查 geo; 域名直接返回 null(后端不解析域名, 调用方 as-is 处理, 不浪费请求)。
function isIpLiteral(s) {
  if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s)   // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s)                 // IPv4
}
// 解析一个 IP 的地理(经缓存)。GeoResult = { ip, cc, city, province, asn, prefix, lat, lon, source, place }
export function resolveGeo(ip) {
  const key = (ip || '').trim()
  if (!key || !isIpLiteral(key)) return Promise.resolve(null)
  if (cache.has(key)) return cache.get(key)
  const fn = customResolver || SOURCES[activeSource] || duckdbResolve
  const p = Promise.resolve(fn(key)).catch(() => null)
  cache.set(key, p)
  return p
}
