// 全球路由跟踪监测点清单: 拉 globalping /v1/probes, 按「城市+国家」聚合成可选位置(取代原 mock 的
// 写死 PROBE_LOCATIONS)。每个位置带真实可用探测点数(count)、真实坐标(探测点经纬度均值)、托管网络分布。
// 同时把「城市→坐标」表注入 geo-resolve(供逐跳富集用真实城市坐标, 比国家质心精确)。
//
// 缓存: 内存 + sessionStorage(聚合结果很小, ~1000 条; 不存 2MB 原始清单)。

import { listProbes } from './globalping.js'
import { ccLabel } from './bgp.js'
import { setCityCoordProvider } from './geo-resolve.js'

const SKEY = 'ipc-gp-probes-v1'
const TTL = 6 * 3600 * 1000   // 6h

let _locations = null          // 聚合后的位置数组(按 count 降序)
let _cityCoord = new Map()     // `${cc}|${cityLower}` -> {lat,lon}
let _inflight = null

const slug = (cc, city) => (cc + '-' + city).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const ckey = (cc, city) => (cc || '').toUpperCase() + '|' + (city || '').trim().toLowerCase()

function aggregate(probes) {
  const byCity = new Map()   // ckey -> { city, cc, latSum, lonSum, n, nets:Map(name->{asn,n}) }
  for (const p of probes) {
    const L = p.location || {}
    if (!L.city || !L.country) continue
    const k = ckey(L.country, L.city)
    let o = byCity.get(k)
    if (!o) { o = { city: L.city, cc: L.country, latSum: 0, lonSum: 0, n: 0, nets: new Map() }; byCity.set(k, o) }
    o.n++; o.latSum += L.latitude || 0; o.lonSum += L.longitude || 0
    if (L.network) { const nn = o.nets.get(L.network) || { asn: L.asn || 0, name: L.network, n: 0 }; nn.n++; o.nets.set(L.network, nn) }
  }
  const locs = []
  const coord = new Map()
  for (const [k, o] of byCity) {
    const lat = o.latSum / o.n, lon = o.lonSum / o.n
    coord.set(k, { lat, lon })
    locs.push({
      id: slug(o.cc, o.city), city: o.city, cc: o.cc, country: ccLabel(o.cc) || o.cc,
      lat, lon, count: o.n,
      networks: [...o.nets.values()].sort((a, b) => b.n - a.n).slice(0, 12),
    })
  }
  locs.sort((a, b) => b.count - a.count)
  return { locs, coord }
}

function applyCoord(coord) {
  _cityCoord = coord
  setCityCoordProvider((cc, city) => _cityCoord.get(ckey(cc, city)) || null)
}

function loadCache() {
  try {
    const raw = sessionStorage.getItem(SKEY); if (!raw) return null
    const j = JSON.parse(raw)
    if (!j || !j.t || Date.now() - j.t > TTL || !Array.isArray(j.locs)) return null
    return j
  } catch { return null }
}
function saveCache(locs, coordEntries) {
  try { sessionStorage.setItem(SKEY, JSON.stringify({ t: Date.now(), locs, coord: coordEntries })) } catch { /* 隐私模式忽略 */ }
}

// 取监测点位置清单(缓存)。返回按 count 降序的位置数组。失败抛出(上层提示, 退化到无监测点)。
export async function loadProbeLocations() {
  if (_locations) return _locations
  if (_inflight) return _inflight
  const cached = loadCache()
  if (cached) {
    _locations = cached.locs
    applyCoord(new Map(cached.coord))
    return _locations
  }
  _inflight = (async () => {
    const probes = await listProbes()
    const { locs, coord } = aggregate(probes)
    _locations = locs
    applyCoord(coord)
    saveCache(locs, [...coord.entries()])
    return locs
  })()
  try { return await _inflight } finally { _inflight = null }
}

// 同步取已加载的位置(未加载返回 []); 供组件 derived 用。
export function probeLocations() { return _locations || [] }

// 选中位置 + 取样数 -> globalping locations 过滤项。city+country 精确定位该都会的探测点。
export function toGpLocation(loc, count) {
  return { city: loc.city, country: loc.cc, limit: Math.max(1, Math.min(50, count || 1)) }
}
