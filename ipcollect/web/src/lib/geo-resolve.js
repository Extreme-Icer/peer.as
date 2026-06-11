// IP → 地理坐标解析(可插拔, 多数据源)。供全球路由跟踪把每一跳 / 目标 IP 落到地球上。
//
// 内置数据源(setGeoSource 切换, 默认 nexttrace):
//   · 'duckdb'    —— 本项目自有数据: cc/city/asn/prefix 来自 DuckDB geo 数据集(queries.geoEnrich,
//                    异步), 坐标用「真实探测点城市坐标表」(trace-probes 注入)→ 国家质心 CC_CENTROID。
//                    坐标只到城市/国家级(DuckDB 无逐 IP 经纬)。
//   · 'nexttrace' —— NextTrace API v4 GeoIP(api.nxtrace.org/v4/ipGeo, 需 token), 返回逐 IP 精确
//                    经纬度 + 国家/省/城市/ASN/前缀。无 token / 查询失败 / 无坐标时回退 duckdb,
//                    保证地球始终可画。token 用 setGeoToken 注入(前端 settings 保存)。
//
// setGeoResolver(fn) 仍可整体换成任意自定义解析器(覆盖上面的数据源选择)。接口形状不变,
// 上层(globalping.streamTrace 富集每跳)一行不用改。

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

// ── 数据源 2: NextTrace API v4 GeoIP(逐 IP 精确经纬度, 需 token)──────────────
const NT_ENDPOINT = 'https://api.nxtrace.org/v4/ipGeo'
let ntToken = ''
export function setGeoToken(tk) { tk = (tk || '').trim(); if (tk !== ntToken) { ntToken = tk; cache.clear() } }
export function getGeoToken() { return ntToken }

// 单次 NextTrace 查询; 无 token / 非 2xx / 超时 / 无坐标 -> null(由 nexttraceResolve 回退 duckdb)。
async function nexttraceLookup(ip) {
  if (!ntToken) return null
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), 6000)
  try {
    const r = await fetch(NT_ENDPOINT + '?ip=' + encodeURIComponent(ip),
      { headers: { 'X-NextTrace-Token': ntToken, Accept: 'application/json' }, signal: c.signal })
    if (!r.ok) return null
    const j = await r.json()
    const lat = typeof j.lat === 'number' ? j.lat : parseFloat(j.lat)
    const lon = typeof j.lng === 'number' ? j.lng : parseFloat(j.lng)
    if (!isFinite(lat) || !isFinite(lon)) return null
    const asn = j.asnumber ? parseInt(String(j.asnumber).replace(/^AS/i, ''), 10) : null
    // 地名按当前界面语言取(NextTrace 同时返回中文与 *_en 英文); zh 优先中文, 否则英文。
    const zh = S?.lang === 'zh'
    const pick = (z, e) => (zh ? (z || e) : (e || z)) || ''
    return {
      ip, lat, lon, asn: isFinite(asn) ? asn : null, prefix: j.prefix || null,
      country: pick(j.country, j.country_en), prov: pick(j.prov, j.prov_en), city: pick(j.city, j.city_en),
    }
  } catch { return null } finally { clearTimeout(tm) }
}
async function nexttraceResolve(ip) {
  const nt = await nexttraceLookup(ip)
  if (nt) {
    const parts = []
    for (const x of [nt.city, nt.prov, nt.country]) { const v = (x || '').trim(); if (v && !parts.includes(v)) parts.push(v) }
    return {
      ip, cc: '', city: nt.city || nt.prov || nt.country, province: nt.prov || '',
      asn: nt.asn, prefix: nt.prefix, lat: nt.lat, lon: nt.lon, source: 'nexttrace', place: parts.join(' · '),
    }
  }
  return duckdbResolve(ip)   // 无 token / 失败 / 无坐标: 回退本项目数据(地球仍可画)
}

// ── 数据源注册 + 选择 ─────────────────────────────────────────────────────────
const SOURCES = { duckdb: duckdbResolve, nexttrace: nexttraceResolve }
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
