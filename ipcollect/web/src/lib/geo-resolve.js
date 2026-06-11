// IP → 地理坐标解析(可插拔)。供全球路由跟踪把每一跳 / 目标 IP 落到地球上。
//
// 默认解析器 = 本项目自有数据:
//   · cc/city/province/origin-asn/prefix —— DuckDB geo 数据集(queries.geoEnrich, 异步加载+查询)
//   · 坐标 lat/lon —— 先用「真实探测点城市坐标表」(trace-probes 注入, 城市级精确),
//                      退回 geo.js 的国家质心 CC_CENTROID(国家级近似)。
// DuckDB 本身不含逐 IP 经纬度, 故坐标是城市/国家级近似 —— 这是当前已知的精度上限。
//
// 可插拔: setGeoResolver(fn) 整体换成在线 geoip API(返回逐 IP 精确经纬度); 接口形状不变,
// 上层(globalping.streamTrace 富集每跳)一行不用改。setCityCoordProvider 单独换城市坐标源。

import { ccLatLon } from './geo.js'
import { geoEnrich } from './queries.js'

// (cc, city) -> {lat,lon} | null。由 trace-probes 用真实 globalping 探测点坐标填充(城市级)。
let cityCoordFn = null
export function setCityCoordProvider(fn) { cityCoordFn = fn }

// 整体解析器: ip -> Promise<GeoResult|null>。null=用默认(DuckDB+质心)。
// GeoResult = { ip, cc, city, province, asn, prefix, lat, lon, source }
//   source: 'city'(城市坐标表) | 'centroid'(国家质心) | 'api'(在线) | 'none'(无坐标)
let resolver = null
export function setGeoResolver(fn) { resolver = fn }

// 解析缓存(ip -> Promise): 同一 IP 多跳并发只查一次; 跨一次跟踪持续有效。
const cache = new Map()
export function clearGeoCache() { cache.clear() }

// 默认解析器: DuckDB geo 富集(queries.geoEnrich 内部按需 ensureEngine)+ 坐标补全。
async function defaultResolve(ip) {
  const m = await geoEnrich(ip)
  if (!m) return null
  const cc = m.cc && m.cc !== 'ZZ' ? m.cc : ''
  let lat = null, lon = null, source = 'none'
  if (cc && m.city && cityCoordFn) {
    const c = cityCoordFn(cc, m.city)
    if (c) { lat = c.lat; lon = c.lon; source = 'city' }
  }
  if (lat == null && cc) { const c = ccLatLon(cc); lat = c.lat; lon = c.lon; source = 'centroid' }
  return {
    ip, cc, city: m.city || '', province: m.province || '',
    asn: m.asn ?? null, prefix: m.prefix ?? null,
    lat, lon, source,
  }
}

// 解析一个 IP 的地理(经缓存)。失败/无覆盖 -> null 或坐标为 null 的部分结果。
export function resolveGeo(ip) {
  const key = (ip || '').trim()
  if (!key) return Promise.resolve(null)
  if (cache.has(key)) return cache.get(key)
  const p = Promise.resolve((resolver || defaultResolve)(key)).catch(() => null)
  cache.set(key, p)
  return p
}
