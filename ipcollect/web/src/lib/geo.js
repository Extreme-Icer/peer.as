// 地理坐标表 + 用户来源探测 —— 供首页 3D 地球 doodle(Doodle.svelte)定位节点。
// Tier-1 用「代表性城市」固定坐标; 用户来源用 cloudflare trace 的 loc(国家)→ 质心。

// 24 个 Tier-1(与 bgp.js TIER1 一致)的代表性城市坐标 [纬度, 经度]。
export const TIER1_GEO = {
  2914:  { lat: 35.6762, lon: 139.6503 }, // NTT · Tokyo
  3491:  { lat: 22.3193, lon: 114.1694 }, // PCCW · Hong Kong
  7473:  { lat: 1.3521,  lon: 103.8198 }, // Singtel · Singapore
  6453:  { lat: 19.0760, lon: 72.8777  }, // Tata · Mumbai
  1299:  { lat: 59.3293, lon: 18.0686  }, // Arelion · Stockholm
  1273:  { lat: 51.5074, lon: -0.1278  }, // Vodafone · London
  5511:  { lat: 48.8566, lon: 2.3522   }, // Orange · Paris
  3320:  { lat: 50.1109, lon: 8.6821   }, // DTAG · Frankfurt
  702:   { lat: 52.3676, lon: 4.9041   }, // Verizon EU · Amsterdam
  12956: { lat: 40.4168, lon: -3.7038  }, // Telefónica · Madrid
  6762:  { lat: 38.1157, lon: 13.3615  }, // TI Sparkle · Palermo
  3257:  { lat: 45.4642, lon: 9.1900   }, // GTT · Milan
  6830:  { lat: 48.2082, lon: 16.3738  }, // Liberty Global · Vienna
  701:   { lat: 39.0438, lon: -77.4874 }, // Verizon · Ashburn
  174:   { lat: 38.9072, lon: -77.0369 }, // Cogent · Washington
  3551:  { lat: 42.3601, lon: -71.0589 }, // Verizon MFS · Boston
  3549:  { lat: 25.7617, lon: -80.1918 }, // Lumen GX · Miami
  6461:  { lat: 41.8781, lon: -87.6298 }, // Zayo · Chicago
  1239:  { lat: 39.0997, lon: -94.5786 }, // Sprint · Kansas City
  7018:  { lat: 32.7767, lon: -96.7970 }, // AT&T · Dallas
  3356:  { lat: 39.7392, lon: -104.9903 },// Lumen L3 · Denver
  209:   { lat: 34.0522, lon: -118.2437 },// Lumen Qwest · Los Angeles
  6939:  { lat: 37.5485, lon: -121.9886 },// HE · Fremont
  2828:  { lat: 47.6062, lon: -122.3321 },// Verizon XO · Seattle
}

// 国家/地区 → 大致质心坐标 [纬度, 经度](用户来源 loc 定位)。缺失回退 0,0 附近。
export const CC_CENTROID = {
  CN:[35.0,103.0], HK:[22.32,114.17], TW:[23.7,121.0], MO:[22.16,113.55], JP:[36.2,138.3],
  KR:[36.5,127.9], SG:[1.35,103.82], MY:[4.2,101.9], TH:[15.0,101.0], VN:[16.2,107.8],
  IN:[22.0,79.0], ID:[-2.5,118.0], PH:[12.8,121.8], AU:[-25.0,134.0], NZ:[-41.0,174.0],
  US:[39.0,-98.0], CA:[56.0,-106.0], MX:[23.6,-102.5], BR:[-10.0,-52.0], AR:[-34.0,-64.0],
  GB:[54.0,-2.0], IE:[53.4,-8.0], FR:[46.6,2.4], DE:[51.2,10.4], NL:[52.2,5.3], BE:[50.6,4.6],
  LU:[49.8,6.1], CH:[46.8,8.2], AT:[47.6,14.1], IT:[42.8,12.8], ES:[40.0,-3.7], PT:[39.6,-8.0],
  SE:[62.0,15.0], NO:[64.0,11.0], FI:[64.0,26.0], DK:[56.0,9.5], PL:[52.0,19.0], CZ:[49.8,15.5],
  RU:[61.5,99.0], UA:[48.4,31.2], TR:[39.0,35.2], IL:[31.4,35.0], AE:[24.0,54.0], SA:[24.0,45.0],
  ZA:[-29.0,24.0], EG:[26.8,30.8], NG:[9.1,8.7], KE:[0.2,37.9],
}

// cloudflare trace: 取用户连接 IP(ip)与国家(loc)。失败返回 null(不阻塞页面)。
const TRACE_URL = 'https://default.peer.as/cdn-cgi/trace'
export async function fetchTrace() {
  try {
    const r = await fetch(TRACE_URL, { cache: 'no-store' })
    if (!r.ok) return null
    const txt = await r.text()
    const kv = {}
    for (const line of txt.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1) }
    if (!kv.ip) return null
    return { ip: kv.ip, cc: (kv.loc || '').toUpperCase() }
  } catch (e) { return null }
}

// 国家 → 坐标(缺失给一个海上默认, 避免 NaN)。
export function ccLatLon(cc) {
  const c = CC_CENTROID[(cc || '').toUpperCase()]
  return c ? { lat: c[0], lon: c[1] } : { lat: 20, lon: 0 }
}

// ── 用户来源 IP 双栈探测(test-ipv6.com)──────────────────────────────
// 这些站点只提供 JSONP(?callback=)接口、无 CORS, 故用 <script> 注入回调取数。
// 三个子域名分别强制 IPv4 / IPv6 / 双栈连接, 据此看出本机 v4/v6 各自的出口地址与默认栈偏好。
const SELF_IP = {
  v4: 'https://ipv4.singapore.test-ipv6.com/ip/',  // 强制走 IPv4 → 你的 v4 出口
  v6: 'https://ipv6.singapore.test-ipv6.com/ip/',  // 强制走 IPv6 → 你的 v6 出口(无 v6 则超时失败)
  ds: 'https://ds.singapore.test-ipv6.com/ip/',    // 双栈 → 浏览器实际优先选用的那个栈
}

// JSONP 取数: 注入 <script src=...&callback=cb>, 服务端回 cb({...})。超时/失败 resolve(null)。
let _jsonpN = 0
export function jsonp(url, timeout = 8000) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return }
    const cb = '__ipc_jsonp_' + (++_jsonpN)
    const s = document.createElement('script')
    let done = false
    let tm
    const cleanup = () => {
      try { delete window[cb] } catch (e) { window[cb] = undefined }
      if (s.parentNode) s.parentNode.removeChild(s)
      clearTimeout(tm)
    }
    const finish = (v) => { if (done) return; done = true; cleanup(); resolve(v) }
    window[cb] = (data) => finish(data)
    s.onerror = () => finish(null)
    tm = setTimeout(() => finish(null), timeout)
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb
    document.head.appendChild(s)
  })
}

// 并行探测 v4 / v6 / 双栈, 返回 { v4, v6, ds } —— 各为 IP 字符串(探测不到则 null)。
// v6 探测会在无 IPv6 连通时超时(故 timeout 较短), 这是预期的(说明本机纯 v4)。
export async function probeSelfIps() {
  const pick = (d) => (d && typeof d.ip === 'string' && d.ip) ? d.ip : null
  const [v4, v6, ds] = await Promise.all([
    jsonp(SELF_IP.v4, 8000),
    jsonp(SELF_IP.v6, 6000),
    jsonp(SELF_IP.ds, 8000),
  ])
  return { v4: pick(v4), v6: pick(v6), ds: pick(ds) }
}

// ── 多端点出口 IP 探测 ────────────────────────────────────────────────
// 请求一批开放 CORS 的边缘端点(Cloudflare cdn-cgi/trace + upyun 节点探测), 取各端点看到的
// 客户端 IP。多 WAN / 多线 / happy-eyeballs / CDN 不同 PoP 会让不同站点看到不同出口地址,
// 借此把"你实际拥有的全部接入出口"摸出来; 去重后按 family(v4/v6)分组、按出现频次排序。
// 任一端点失败/超时静默忽略, 不阻塞首页。
const EGRESS_TRACE = [
  'https://cdnjs.cloudflare.com/cdn-cgi/trace',
  'https://coinbase.com/cdn-cgi/trace',
  'https://www.okx.com/cdn-cgi/trace',
  'https://testingcf.jsdelivr.net/cdn-cgi/trace',
  'https://cloudflaremirrors.com/cdn-cgi/trace',
  'https://registry.npmjs.org/cdn-cgi/trace',
  'https://kali.download/cdn-cgi/trace',
  'https://app.unpkg.com/cdn-cgi/trace',
  'https://crunchyroll.com/cdn-cgi/trace',
  'https://nodejs.org/cdn-cgi/trace',
  'https://gitlab.com/cdn-cgi/trace',
  'https://openai.com/cdn-cgi/trace',
  'https://claude.ai/cdn-cgi/trace',
  'https://grok.com/cdn-cgi/trace',
  'https://anthropic.com/cdn-cgi/trace',
  'https://www.perplexity.ai/cdn-cgi/trace',
  'https://chatgpt.com/cdn-cgi/trace',
  'https://sora.com/cdn-cgi/trace',
  'https://gateway.discord.gg/cdn-cgi/trace',
  'https://x.com/cdn-cgi/trace',
  'https://medium.com/cdn-cgi/trace',
  'https://perfops.cloudflareperf.com/cdn-cgi/trace',
  'https://www.qualcomm.cn/cdn-cgi/trace',
  'https://www.cf-ns.com/cdn-cgi/trace',
]
const EGRESS_UPYUN = 'https://pubstatic.b0.upaiyun.com/?_upnode'

// 单端点 fetch + 超时(AbortController): 慢端点不拖垮整体, 失败一律 resolve(null)。
async function fetchWithTimeout(url, ms = 7000) {
  const c = new AbortController()
  const tm = setTimeout(() => c.abort(), ms)
  try { return await fetch(url, { cache: 'no-store', signal: c.signal }) }
  catch (e) { return null }
  finally { clearTimeout(tm) }
}

async function traceIp(url) {
  const r = await fetchWithTimeout(url)
  if (!r || !r.ok) return null
  try {
    const txt = await r.text()
    for (const line of txt.split('\n')) if (line.startsWith('ip=')) { const v = line.slice(3).trim(); return v || null }
  } catch (e) { /* ignore */ }
  return null
}

async function upyunIp(url) {
  const r = await fetchWithTimeout(url + '&_=' + Date.now())
  if (!r || !r.ok) return null
  try {
    const j = await r.json()
    return (typeof j.remote_addr === 'string' && j.remote_addr) ? j.remote_addr : null
  } catch (e) { return null }
}

export async function probeEgressIps() {
  const results = await Promise.all([
    ...EGRESS_TRACE.map(u => traceIp(u)),
    upyunIp(EGRESS_UPYUN),
  ])
  const count = new Map()
  for (const ip of results) if (ip) count.set(ip, (count.get(ip) || 0) + 1)
  const v4 = [], v6 = []
  for (const [ip, n] of count) (ip.includes(':') ? v6 : v4).push({ ip, n })
  const byN = (a, b) => b.n - a.n
  v4.sort(byN); v6.sort(byN)
  // 默认出口 = 被最多端点看到的那个地址(浏览器实际主用的接入), 用于卡片上的 live 小点。
  let defaultIp = null, best = -1
  for (const [ip, n] of count) if (n > best) { best = n; defaultIp = ip }
  return { v4: v4.map(x => x.ip), v6: v6.map(x => x.ip), defaultIp }
}
