// 全球路由跟踪 —— 监测点 + MTR 数据(DEMO 静态 mock)。
//
// 设计目标: 数据形状与 globalping.io 的 measurements(type=mtr)对齐 + 经我们自有 IP 库富集后的
// 「最终态」。这样把下面的 streamTrace() 换成真实实现(POST /v1/measurements → 轮询结果 →
// 每跳 IP 用 ipc 库查 geo/asn 富集)即可无缝切到 live, 上层(引擎 / 控制台)一行不用改。
//
// 暴露给上层的模型(engine.setData 消费):
//   model = {
//     target: { ip, label, lat, lon, cc, city } | null,
//     probes: [{
//       id, color:[r,g,b], colorHex, city, cc, country, network, asn, lat, lon,
//       status: 'queued'|'probing'|'done'|'failed',
//       hops: [{ idx, ip, asn, name, cc, city, lat, lon, rtt, loss, isTarget }]
//     }]
//   }
//
// streamTrace(target, probeIds, handlers) -> { cancel() }
//   把「逐跳返回」模拟成真实 MTR 的流式过程(probe 上线 → 一跳一跳回 → 完成),
//   上层据此让控制台与地球同步「生长」。handlers: { onInit, onHop, onProbeDone, onDone }。

import { asnName } from './bgp.js'

const D2R = Math.PI / 180

// ── 确定性伪随机(按字符串播种)—— 同一输入每次得到同一拓扑/几何, 不随刷新跳动 ──
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0)
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// 大圆距离(km)
function gcKm(a, b) {
  const r = D2R, R = 6371
  const dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// 监测点配色(深空背景下高亮、彼此可分)。前 N 个尽量色相分散。
const PALETTE = [
  [45, 212, 191],   // teal(品牌 accent)
  [56, 189, 248],   // sky
  [251, 191, 36],   // amber(signal)
  [167, 139, 250],  // violet
  [52, 211, 153],   // emerald
  [244, 114, 182],  // pink
  [250, 204, 21],   // yellow
  [129, 140, 248],  // indigo
  [34, 211, 238],   // cyan
  [163, 230, 53],   // lime
  [251, 146, 60],   // orange
  [96, 165, 250],   // blue
]
const hex = ([r, g, b]) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')

// ── 探测点地理位置(globalping 形态)──────────────────────────────────────────
// 每个位置(城市)托管若干 probe; count = 该位置可用 probe 数(地球上的光点越多越亮)。
// 单个 probe 由 probeById(`${locId}-${i}`) 确定性生成(asn/network/经纬抖动), 切 live 时换成
// globalping /v1/probes 的真实清单即可。
export const PROBE_LOCATIONS = [
  // 欧洲
  { id: 'lon', city: 'London',       cc: 'GB', country: 'United Kingdom', lat: 51.5074, lon: -0.1278,  count: 48 },
  { id: 'fra', city: 'Frankfurt',    cc: 'DE', country: 'Germany',        lat: 50.1109, lon: 8.6821,   count: 52 },
  { id: 'ams', city: 'Amsterdam',    cc: 'NL', country: 'Netherlands',    lat: 52.3676, lon: 4.9041,   count: 40 },
  { id: 'par', city: 'Paris',        cc: 'FR', country: 'France',         lat: 48.8566, lon: 2.3522,   count: 34 },
  { id: 'mad', city: 'Madrid',       cc: 'ES', country: 'Spain',          lat: 40.4168, lon: -3.7038,  count: 18 },
  { id: 'mil', city: 'Milan',        cc: 'IT', country: 'Italy',          lat: 45.4642, lon: 9.1900,   count: 16 },
  { id: 'waw', city: 'Warsaw',       cc: 'PL', country: 'Poland',         lat: 52.2297, lon: 21.0122,  count: 14 },
  { id: 'sto', city: 'Stockholm',    cc: 'SE', country: 'Sweden',         lat: 59.3293, lon: 18.0686,  count: 15 },
  { id: 'hel', city: 'Helsinki',     cc: 'FI', country: 'Finland',        lat: 60.1699, lon: 24.9384,  count: 10 },
  { id: 'vie', city: 'Vienna',       cc: 'AT', country: 'Austria',        lat: 48.2082, lon: 16.3738,  count: 11 },
  { id: 'zrh', city: 'Zurich',       cc: 'CH', country: 'Switzerland',    lat: 47.3769, lon: 8.5417,   count: 13 },
  { id: 'dub', city: 'Dublin',       cc: 'IE', country: 'Ireland',        lat: 53.3498, lon: -6.2603,  count: 12 },
  { id: 'buh', city: 'Bucharest',    cc: 'RO', country: 'Romania',        lat: 44.4268, lon: 26.1025,  count: 12 },
  { id: 'mow', city: 'Moscow',       cc: 'RU', country: 'Russia',         lat: 55.7558, lon: 37.6173,  count: 14 },
  { id: 'ist', city: 'Istanbul',     cc: 'TR', country: 'Türkiye',        lat: 41.0082, lon: 28.9784,  count: 13 },
  // 北美
  { id: 'iad', city: 'Ashburn',      cc: 'US', country: 'United States',  lat: 39.0438, lon: -77.4874, count: 50 },
  { id: 'nyc', city: 'New York',     cc: 'US', country: 'United States',  lat: 40.7128, lon: -74.0060, count: 44 },
  { id: 'lax', city: 'Los Angeles',  cc: 'US', country: 'United States',  lat: 34.0522, lon: -118.2437,count: 38 },
  { id: 'sjc', city: 'San Jose',     cc: 'US', country: 'United States',  lat: 37.3382, lon: -121.8863,count: 36 },
  { id: 'chi', city: 'Chicago',      cc: 'US', country: 'United States',  lat: 41.8781, lon: -87.6298, count: 24 },
  { id: 'dfw', city: 'Dallas',       cc: 'US', country: 'United States',  lat: 32.7767, lon: -96.7970, count: 22 },
  { id: 'mia', city: 'Miami',        cc: 'US', country: 'United States',  lat: 25.7617, lon: -80.1918, count: 20 },
  { id: 'sea', city: 'Seattle',      cc: 'US', country: 'United States',  lat: 47.6062, lon: -122.3321,count: 16 },
  { id: 'yyz', city: 'Toronto',      cc: 'CA', country: 'Canada',         lat: 43.6532, lon: -79.3832, count: 18 },
  { id: 'yvr', city: 'Vancouver',    cc: 'CA', country: 'Canada',         lat: 49.2827, lon: -123.1207,count: 10 },
  // 亚洲
  { id: 'tyo', city: 'Tokyo',        cc: 'JP', country: 'Japan',          lat: 35.6762, lon: 139.6503, count: 34 },
  { id: 'osa', city: 'Osaka',        cc: 'JP', country: 'Japan',          lat: 34.6937, lon: 135.5023, count: 12 },
  { id: 'sin', city: 'Singapore',    cc: 'SG', country: 'Singapore',      lat: 1.3521,  lon: 103.8198, count: 30 },
  { id: 'hkg', city: 'Hong Kong',    cc: 'HK', country: 'Hong Kong',      lat: 22.3193, lon: 114.1694, count: 22 },
  { id: 'icn', city: 'Seoul',        cc: 'KR', country: 'South Korea',    lat: 37.5665, lon: 126.9780, count: 18 },
  { id: 'bom', city: 'Mumbai',       cc: 'IN', country: 'India',          lat: 19.0760, lon: 72.8777,  count: 24 },
  { id: 'del', city: 'Delhi',        cc: 'IN', country: 'India',          lat: 28.6139, lon: 77.2090,  count: 16 },
  { id: 'blr', city: 'Bangalore',    cc: 'IN', country: 'India',          lat: 12.9716, lon: 77.5946,  count: 14 },
  { id: 'bkk', city: 'Bangkok',      cc: 'TH', country: 'Thailand',       lat: 13.7563, lon: 100.5018, count: 12 },
  { id: 'kul', city: 'Kuala Lumpur', cc: 'MY', country: 'Malaysia',       lat: 3.1390,  lon: 101.6869, count: 10 },
  { id: 'cgk', city: 'Jakarta',      cc: 'ID', country: 'Indonesia',      lat: -6.2088, lon: 106.8456, count: 11 },
  { id: 'dxb', city: 'Dubai',        cc: 'AE', country: 'UAE',            lat: 25.2048, lon: 55.2708,  count: 14 },
  { id: 'tlv', city: 'Tel Aviv',     cc: 'IL', country: 'Israel',         lat: 32.0853, lon: 34.7818,  count: 10 },
  // 大洋洲
  { id: 'syd', city: 'Sydney',       cc: 'AU', country: 'Australia',      lat: -33.8688,lon: 151.2093, count: 20 },
  { id: 'mel', city: 'Melbourne',    cc: 'AU', country: 'Australia',      lat: -37.8136,lon: 144.9631, count: 12 },
  { id: 'akl', city: 'Auckland',     cc: 'NZ', country: 'New Zealand',    lat: -36.8485,lon: 174.7633, count: 8 },
  // 南美
  { id: 'gru', city: 'São Paulo',    cc: 'BR', country: 'Brazil',         lat: -23.5505,lon: -46.6333, count: 22 },
  { id: 'eze', city: 'Buenos Aires', cc: 'AR', country: 'Argentina',      lat: -34.6037,lon: -58.3816, count: 10 },
  { id: 'scl', city: 'Santiago',     cc: 'CL', country: 'Chile',          lat: -33.4489,lon: -70.6693, count: 9 },
  { id: 'bog', city: 'Bogotá',       cc: 'CO', country: 'Colombia',       lat: 4.7110,  lon: -74.0721, count: 8 },
  // 非洲
  { id: 'jnb', city: 'Johannesburg', cc: 'ZA', country: 'South Africa',   lat: -26.2041,lon: 28.0473,  count: 12 },
  { id: 'cpt', city: 'Cape Town',    cc: 'ZA', country: 'South Africa',   lat: -33.9249,lon: 18.4241,  count: 8 },
  { id: 'los', city: 'Lagos',        cc: 'NG', country: 'Nigeria',        lat: 6.5244,  lon: 3.3792,   count: 7 },
  { id: 'nbo', city: 'Nairobi',      cc: 'KE', country: 'Kenya',          lat: -1.2921, lon: 36.8219,  count: 6 },
  { id: 'cai', city: 'Cairo',        cc: 'EG', country: 'Egypt',          lat: 30.0444, lon: 31.2357,  count: 7 },
]
const LOC_BY_ID = Object.fromEntries(PROBE_LOCATIONS.map(L => [L.id, L]))

// probe 托管网络池(globalping 多在数据中心): 给单个 probe 派 asn/network。
const NETS = [
  { asn: 24940, name: 'Hetzner Online' }, { asn: 16276, name: 'OVH' }, { asn: 14061, name: 'DigitalOcean' },
  { asn: 63949, name: 'Akamai (Linode)' }, { asn: 14618, name: 'Amazon AES' }, { asn: 16509, name: 'Amazon EC2' },
  { asn: 20473, name: 'Vultr' }, { asn: 51167, name: 'Contabo' }, { asn: 9009, name: 'M247' },
  { asn: 8075, name: 'Microsoft Azure' }, { asn: 396982, name: 'Google Cloud' }, { asn: 212238, name: 'Datacamp' },
]

// 单个 probe(确定性): id=`${locId}-${i}`。
export function probeById(id) {
  const k = String(id).lastIndexOf('-'); if (k < 0) return null
  const locId = id.slice(0, k), i = parseInt(id.slice(k + 1), 10)
  const loc = LOC_BY_ID[locId]; if (!loc || isNaN(i)) return null
  const rng = mulberry32(hashStr(id))
  const net = NETS[Math.floor(rng() * NETS.length)]
  return {
    id, city: loc.city, cc: loc.cc, country: loc.country, asn: net.asn, network: net.name,
    lat: loc.lat + (rng() - .5) * 0.55, lon: loc.lon + (rng() - .5) * 0.55,
  }
}

// 从某位置随机取 ≤k 个「尚未选中」的 probe id(点击光点时用, 默认 5 个)。
export function sampleProbes(locId, selected, k = 5) {
  const loc = LOC_BY_ID[locId]; if (!loc) return []
  const sel = selected || new Set()
  const avail = []
  for (let i = 0; i < loc.count; i++) { const id = locId + '-' + i; if (!sel.has(id)) avail.push(id) }
  const rng = mulberry32(hashStr(locId + ':' + sel.size))
  for (let i = avail.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = avail[i]; avail[i] = avail[j]; avail[j] = t }
  return avail.slice(0, k)
}

// 默认勾选: 几个跨洲城市各取 1 个 probe → 路径汇聚画面最好看。
export function defaultProbeSelection() { return ['fra-0', 'iad-0', 'tyo-0', 'gru-0', 'syd-0'] }

// ── 骨干中转枢纽(用于编造可信的国际中转跳: 主要 IX / Tier-1 城市)──────────────
const HUBS = [
  { city: 'Amsterdam',   cc: 'NL', asn: 1299,  lat: 52.3676, lon: 4.9041 },
  { city: 'Frankfurt',   cc: 'DE', asn: 3320,  lat: 50.1109, lon: 8.6821 },
  { city: 'London',      cc: 'GB', asn: 3356,  lat: 51.5074, lon: -0.1278 },
  { city: 'Marseille',   cc: 'FR', asn: 6762,  lat: 43.2965, lon: 5.3698 },
  { city: 'New York',    cc: 'US', asn: 174,   lat: 40.7128, lon: -74.0060 },
  { city: 'Ashburn',     cc: 'US', asn: 3356,  lat: 39.0438, lon: -77.4874 },
  { city: 'Miami',       cc: 'US', asn: 6453,  lat: 25.7617, lon: -80.1918 },
  { city: 'San Jose',    cc: 'US', asn: 6939,  lat: 37.3382, lon: -121.8863 },
  { city: 'Los Angeles', cc: 'US', asn: 3356,  lat: 34.0522, lon: -118.2437 },
  { city: 'Tokyo',       cc: 'JP', asn: 2914,  lat: 35.6762, lon: 139.6503 },
  { city: 'Singapore',   cc: 'SG', asn: 6453,  lat: 1.3521,  lon: 103.8198 },
  { city: 'Hong Kong',   cc: 'HK', asn: 3491,  lat: 22.3193, lon: 114.1694 },
  { city: 'Dubai',       cc: 'AE', asn: 8966,  lat: 25.2048, lon: 55.2708 },
  { city: 'São Paulo',   cc: 'BR', asn: 6762,  lat: -23.5505,lon: -46.6333 },
  { city: 'Sydney',      cc: 'AU', asn: 6453,  lat: -33.8688,lon: 151.2093 },
]

// 几个「知名目标」的地理(DEMO 用; live 时由库内 geo 富集替代)。
const KNOWN_TARGETS = {
  '1.1.1.1':       { lat: 25.79, lon: -80.13, cc: 'US', city: 'Cloudflare (anycast)', ip: '1.1.1.1' },
  '8.8.8.8':       { lat: 37.40, lon: -122.08, cc: 'US', city: 'Google (anycast)',    ip: '8.8.8.8' },
  '9.9.9.9':       { lat: 40.71, lon: -74.00, cc: 'US', city: 'Quad9 (anycast)',      ip: '9.9.9.9' },
  'github.com':    { lat: 37.77, lon: -122.42, cc: 'US', city: 'San Francisco',       ip: '140.82.121.4' },
  'cloudflare.com':{ lat: 37.77, lon: -122.42, cc: 'US', city: 'San Francisco',       ip: '104.16.132.229' },
  'google.com':    { lat: 37.40, lon: -122.08, cc: 'US', city: 'Mountain View',       ip: '142.250.72.46' },
  'baidu.com':     { lat: 39.90, lon: 116.40, cc: 'CN', city: 'Beijing',              ip: '110.242.68.66' },
  'peer.as':       { lat: 1.29,  lon: 103.85, cc: 'SG', city: 'Singapore',            ip: '104.21.50.12' },
  'example.com':   { lat: 38.0,  lon: -97.0,  cc: 'US', city: 'United States',        ip: '93.184.216.34' },
}
// 目标着陆城市候选(未知目标时按 hash 落到一个可信的数据中心都会)。
const TARGET_METROS = [
  { lat: 37.77, lon: -122.42, cc: 'US', city: 'San Francisco' },
  { lat: 40.71, lon: -74.00,  cc: 'US', city: 'New York' },
  { lat: 51.51, lon: -0.13,   cc: 'GB', city: 'London' },
  { lat: 50.11, lon: 8.68,    cc: 'DE', city: 'Frankfurt' },
  { lat: 1.35,  lon: 103.82,  cc: 'SG', city: 'Singapore' },
  { lat: 35.68, lon: 139.65,  cc: 'JP', city: 'Tokyo' },
  { lat: 52.37, lon: 4.90,    cc: 'NL', city: 'Amsterdam' },
  { lat: -23.55,lon: -46.63,  cc: 'BR', city: 'São Paulo' },
]

function looksLikeIp(s) { return /^[0-9.]+$/.test(s) || s.includes(':') }
function randIp(rng) { return [rng(), rng(), rng(), rng()].map(x => Math.floor(x * 254) + 1).join('.') }

// 目标 → 地理(+ 一个展示用 IP)。已知目标用预设, 否则 hash 落到一个数据中心都会。
function resolveTarget(target) {
  const key = String(target || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!key) return null
  if (KNOWN_TARGETS[key]) return { ...KNOWN_TARGETS[key], label: target }
  const rng = mulberry32(hashStr(key))
  const m = TARGET_METROS[Math.floor(rng() * TARGET_METROS.length)]
  // 在都会附近抖动一点, 避免多个未知目标完全重合
  return {
    lat: m.lat + (rng() - .5) * 5, lon: m.lon + (rng() - .5) * 5,
    cc: m.cc, city: m.city, ip: looksLikeIp(key) ? target : randIp(rng), label: target,
  }
}

// 选出「大致顺路」的中转枢纽: 绕路代价(detour)最小的几个, 再按离监测点的距离排序成途经顺序。
function pickHubs(probe, target, n) {
  const direct = gcKm(probe, target)
  const scored = HUBS
    .map(h => ({ h, detour: gcKm(probe, h) + gcKm(h, target) - direct, near: gcKm(probe, h) }))
    .filter(x => x.near > 250 && gcKm(x.h, target) > 250)   // 别选离两端太近的(那是接入/落地跳)
    .sort((a, b) => a.detour - b.detour)
    .slice(0, Math.max(1, n) * 2)                            // 先取候选池
  const chosen = []
  for (const c of scored) {
    if (chosen.length >= n) break
    if (chosen.every(o => gcKm(o.h, c.h) > 800)) chosen.push(c)   // 途经枢纽之间拉开距离, 不挤一团
  }
  return chosen.sort((a, b) => a.near - b.near).map(x => x.h)
}

const nameForAsn = (asn, fallback) => asnName(asn) || fallback || ('AS' + asn)

// 为单个监测点编造一条到目标的逐跳链(已富集 geo/asn 的最终态)。type: ping 只留目标一跳。
function buildHops(probe, target, seedKey, type) {
  const rng = mulberry32(hashStr(seedKey + ':' + probe.id))
  const dist = gcKm(probe, target)
  const nHub = dist < 2000 ? 1 : dist < 8000 ? 2 : 3
  const hubs = pickHubs(probe, target, nHub)

  const stops = []
  // 1) 接入跳(监测点本地 ISP)
  stops.push({ ...jit(probe, rng, .6), asn: probe.asn, name: probe.network, cc: probe.cc, city: probe.city })
  // 2) 国际中转枢纽
  for (const h of hubs) stops.push({ lat: h.lat, lon: h.lon, asn: h.asn, name: nameForAsn(h.asn, h.city + ' IX'), cc: h.cc, city: h.city })
  // 3) 落地跳(目标都会内的最后一跳运营商) + 目标
  stops.push({ ...jit(target, rng, 1.1), asn: 0, name: target.city, cc: target.cc, city: target.city, edge: true })
  stops.push({ lat: target.lat, lon: target.lon, asn: 0, name: target.label, cc: target.cc, city: target.city, target: true })

  // 去掉相邻几乎重合的点(同一都会内连续两跳)
  let pruned = []
  for (const s of stops) {
    const p = pruned[pruned.length - 1]
    if (p && gcKm(p, s) < 120 && !s.target) continue
    pruned.push(s)
  }
  if (type === 'ping') pruned = [pruned[pruned.length - 1]]   // ping: 只到目标的一条直连

  // 累计 RTT: 光纤里 ~0.011 ms/km 往返 + 每跳处理抖动; 单调不降。
  let acc = 0, prev = probe
  return pruned.map((s, i) => {
    const seg = gcKm(prev, s); prev = s
    acc += seg * 0.0112 + 0.4 + rng() * 1.6
    if (i === 0) acc = 0.3 + rng() * 1.4                      // 接入跳基本 0 延迟
    const loss = rng() > 0.94 ? Math.floor(rng() * 12) : 0    // 偶发少量丢包
    return {
      idx: i + 1, ip: s.target ? target.ip : randIp(rng),
      asn: s.asn, name: s.name, cc: s.cc, city: s.city,
      lat: s.lat, lon: s.lon, rtt: Math.round(acc * 10) / 10, loss,
      isTarget: !!s.target,
    }
  })
}
function jit(p, rng, k) { return { lat: p.lat + (rng() - .5) * k, lon: p.lon + (rng() - .5) * k } }

// 完整构建一次 trace(全部跳就绪)。streamTrace 在其上切片模拟流式。
export function buildTrace(target, probeIds, type) {
  const tg = resolveTarget(target)
  if (!tg) return { target: null, probes: [] }
  const ids = (probeIds && probeIds.length ? probeIds : defaultProbeSelection())
  const probes = ids.map((id, i) => {
    const vp = probeById(id)
    if (!vp) return null
    const color = PALETTE[i % PALETTE.length]
    return {
      ...vp, color, colorHex: hex(color),
      status: 'queued', hops: buildHops(vp, tg, tg.label, type),
    }
  }).filter(Boolean)
  return { target: tg, probes }
}

// ── 流式模拟 ──────────────────────────────────────────────────────────────────
// 监测点错峰「上线」, 各自再逐跳回包(间隔 ~ 该跳与上一跳的 RTT 差, 夹在 [min,max])。
// 把这个函数换成真实 globalping 轮询 + 库内 geo 富集即可切 live(handlers 形状不变)。
export function streamTrace(target, probeIds, handlers = {}, opts = {}) {
  // opts = { proto:'icmp'|'udp'|'tcp', port, packets, infinite } —— 切 live 时原样传给 globalping measurement。
  const { onInit, onHop, onProbeDone, onDone, onUpdate } = handlers
  const infinite = !!opts.infinite
  const model = buildTrace(target, probeIds, opts.type)
  const timers = new Set()
  let cancelled = false
  const after = (ms, fn) => { const id = setTimeout(() => { timers.delete(id); if (!cancelled) fn() }, ms); timers.add(id) }
  const jitter = (rtt) => Math.max(.2, Math.round((rtt + (Math.random() - .5) * (rtt * 0.12 + 1)) * 10) / 10)
  // 无尽模式: 探测完后周期性给整条 hops 重新抖动延迟(只更新 RTT, 不重画弧)→ 实时跳动感
  function reprobe(p) {
    const tick = () => {
      if (cancelled) return
      onUpdate && onUpdate(p.id, p.fullHops.map(h => ({ ...h, rtt: jitter(h.rtt) })))
      after(1100 + Math.random() * 700, tick)
    }
    after(1200 + Math.random() * 500, tick)
  }

  // 先把「监测点已就绪、hops 待回」的骨架交给上层(各 probe 此时 hops 为空)。
  const skeleton = {
    target: model.target,
    probes: model.probes.map(p => ({ ...p, status: 'queued', hops: [], fullHops: p.hops })),
  }
  onInit && onInit(skeleton)

  let done = 0
  skeleton.probes.forEach((p, pi) => {
    const launch = 180 + pi * 240 + Math.random() * 160      // 错峰上线
    after(launch, () => {
      p.status = 'probing'
      let t = 0
      p.fullHops.forEach((hop, hi) => {
        const prevRtt = hi === 0 ? 0 : p.fullHops[hi - 1].rtt
        const gap = Math.min(900, Math.max(240, (hop.rtt - prevRtt) * 6 + 200))   // 跳间节奏 ~ RTT 增量
        t += gap
        after(t, () => {
          p.hops.push(hop)
          onHop && onHop(p.id, hop, p)
          if (hop.isTarget) {
            p.status = 'done'
            onProbeDone && onProbeDone(p.id, p)
            if (infinite) reprobe(p)                                  // 无尽: 持续刷新延迟(不触发 onDone, running 保持)
            else if (++done === skeleton.probes.length) onDone && onDone(skeleton)
          }
        })
      })
    })
  })

  return { cancel() { cancelled = true; timers.forEach(clearTimeout); timers.clear() } }
}
