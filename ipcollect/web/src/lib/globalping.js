// Globalping REST API 客户端 + 全球路由跟踪的 live 流式实现。
// API 文档: https://globalping.io/docs/api.globalping.io
//
// streamTrace(target, locations, handlers, opts) 与原 mock(trace-mock)的 handler 形状一致 ——
// 上层(RouteTraceView)消费事件流重建模型, 切 mock↔live 一行不用改:
//   onInit({ target, probes })   probes:[{id,color,colorHex,city,cc,country,network,asn,lat,lon}]
//   onHop(id, hop)               逐跳追加 hop:{idx,ip,asn,name,cc,city,lat,lon,rtt,loss,isTarget}
//   onProbeDone(id, { rounds })  该探测点完成; rounds=到目标的逐包 RTT 样本(光谱小点)
//   onUpdate(id, hops, rounds)   无尽 ping 的后续轮: 整条刷新 + 累加该轮样本
//   onDone()                     全部完成(非无尽)
//   onError(err)                 发起失败(配额/网络/校验)
// 普通: 建 1 个 measurement, 反复 GET 同一 id 直到 finished。
// 无尽 ping: 每轮 finish 后用「首轮 id」当 locations 再发一轮(复用同批探测点), 直到 cancel。
//
// 每一跳 IP 经 geo-resolve.resolveGeo 富集 cc/city/坐标(异步; 默认 DuckDB+质心, 可换在线 geoip)。

import { ccLabel, asnName } from './bgp.js'
import { resolveGeo } from './geo-resolve.js'

const API = 'https://api.globalping.io/v1'

// 可选 API token(匿名 250 测试/小时·IP; 带 token 提额 + 走信用额度)。默认匿名。
let authToken = null
export function setGlobalpingToken(tk) { authToken = tk || null }
function headers(json) {
  const h = json ? { 'Content-Type': 'application/json' } : {}
  if (authToken) h.Authorization = 'Bearer ' + authToken
  return h
}

// 监测点配色(深空背景下高亮、彼此可分; 前 N 个色相分散)。
const PALETTE = [
  [45, 212, 191], [56, 189, 248], [251, 191, 36], [167, 139, 250],
  [52, 211, 153], [244, 114, 182], [250, 204, 21], [129, 140, 248],
  [34, 211, 238], [163, 230, 53], [251, 146, 60], [96, 165, 250],
]
const hex = ([r, g, b]) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')

// ── 原始 API ────────────────────────────────────────────────────────────────
export async function listProbes() {
  const r = await fetch(API + '/probes', { headers: headers(false) })
  if (!r.ok) throw new Error('probes HTTP ' + r.status)
  return r.json()
}
export async function createMeasurement(body) {
  const r = await fetch(API + '/measurements', { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
  if (!r.ok) {
    let msg = 'HTTP ' + r.status
    try { const e = await r.json(); msg = e?.error?.message || (e?.error?.type) || msg } catch { /* */ }
    if (r.status === 429) msg = 'rate-limited'   // 配额耗尽(匿名 250/小时)
    const err = new Error(msg); err.status = r.status; throw err
  }
  return r.json()   // { id, probesCount }
}
async function getMeasurement(id) {
  const r = await fetch(API + '/measurements/' + id, { headers: headers(false) })
  if (!r.ok) throw new Error('measurement HTTP ' + r.status)
  return r.json()
}

// ── 请求体构造 ────────────────────────────────────────────────────────────────
// opts = { type:'ping'|'traceroute'|'mtr', proto:'icmp'|'udp'|'tcp', port, packets, family:'auto'|'4'|'6', infinite }
// 按 spec(api.globalping.io/v1/spec.yaml)各类型可用项:
//   ping       : protocol ∈ {ICMP,TCP}; packets(1-16); port 仅 TCP
//   traceroute : protocol ∈ {ICMP,TCP,UDP}; 无 packets; port 仅 TCP
//   mtr        : protocol ∈ {ICMP,TCP,UDP}; packets(1-16); port ∈ TCP/UDP
//   ipVersion 仅域名目标可设(IP 字面量已定栈, 否则 API 校验报错)
function buildBody(target, locations, opts = {}) {
  const type = opts.type || 'mtr'
  const proto = (opts.proto || 'icmp').toUpperCase()
  const packets = Math.max(1, Math.min(16, parseInt(opts.packets, 10) || 3))
  const port = Math.max(0, Math.min(65535, parseInt(opts.port, 10) || 80))
  const mo = {}
  if (type === 'ping') {
    mo.packets = packets                              // 无尽 ping 也用配置的包数(默认 3, 每轮快速返回再滚下一轮)
    if (proto === 'TCP') { mo.protocol = 'TCP'; mo.port = port } else mo.protocol = 'ICMP'
  } else if (type === 'traceroute') {
    mo.protocol = proto
    if (proto === 'TCP') mo.port = port
  } else {                                            // mtr
    mo.protocol = proto; mo.packets = packets
    if (proto === 'TCP' || proto === 'UDP') mo.port = port
  }
  if (isDomain(target)) {
    if (opts.family === '4') mo.ipVersion = 4
    else if (opts.family === '6') mo.ipVersion = 6
  }
  return { type, target, locations, inProgressUpdates: true, measurementOptions: mo }
}
// 目标是域名(非 IPv4/IPv6 字面量)。
function isDomain(t) {
  const s = String(t || '').trim()
  if (!s) return false
  if (s.includes(':')) return false                 // IPv6 字面量
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(s)          // 非 IPv4 点分 = 域名
}
// 私网 / LAN / 保留地址(无公网地理意义): 这些跳一律当作不存在, 直接连接前后两个有地理的跳。
function isPrivate(ip) {
  if (!ip) return true
  if (ip.includes(':')) {
    const s = ip.toLowerCase()
    return s === '::1' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')
      || s.startsWith('fc') || s.startsWith('fd')   // ULA fc00::/7; link-local fe80::/10
  }
  const m = ip.split('.').map(Number)
  if (m.length !== 4 || m.some(x => isNaN(x))) return true
  const [a, b] = m
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)   // CGNAT 100.64/10
}

// ── API 结果 → 模型 ──────────────────────────────────────────────────────────
function probeMeta(res, i) {
  const pr = res.probe || {}
  const color = PALETTE[i % PALETTE.length]
  return {
    id: 'p' + i, color, colorHex: hex(color),
    city: pr.city || '', cc: pr.country || '', country: ccLabel(pr.country) || pr.country || '',
    network: pr.network || '', asn: pr.asn || 0,
    lat: pr.latitude, lon: pr.longitude,
  }
}

// 一跳的 RTT(ms): mtr 用 stats.min(最优, 单调更稳); traceroute 用 timings 最小值。无样本 -> null。
function hopRtt(h) {
  if (h.stats && h.stats.rcv > 0) return Math.round((h.stats.min ?? h.stats.avg ?? 0) * 10) / 10
  const ts = (h.timings || []).map(t => t.rtt).filter(x => x != null)
  return ts.length ? Math.round(Math.min(...ts) * 10) / 10 : null
}

// 把一个 probe 结果的逐跳富集成模型 hops(异步 geo)。丢弃无地址(* * *)/无坐标的跳, 保证几何有效。
// ping 无 hops -> 合成「到目标的一跳」。最后一条命中目标地址者标 isTarget。
async function buildHops(res, type, targetIp) {
  const r = res.result || {}
  const tgtIp = r.resolvedAddress || targetIp
  const out = []
  if (type === 'ping') {
    const rtt = hopRtt({ stats: r.stats, timings: r.timings })
    const g = await resolveGeo(tgtIp)
    if (g && g.lat != null) out.push(mkHop(1, tgtIp, g, rtt, r.stats?.loss ?? 0, true, asnName(g.asn)))
    return out
  }
  const hops = r.hops || []
  let idx = 0
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i]
    const ip = h.resolvedAddress
    if (!ip || isPrivate(ip)) continue                 // * * * 超时跳 / LAN·私网: 当作不存在, 连前后有地理的跳
    const g = await resolveGeo(ip)
    if (!g || g.lat == null) continue                  // 地区不明: 同样跳过(连前后); 在线 geoip 接入后可补全
    const asn = (h.asn && h.asn.length ? h.asn[0] : null) ?? g.asn ?? 0
    out.push(mkHop(++idx, ip, g, hopRtt(h), h.stats?.loss ?? 0, ip === tgtIp, asnName(asn) || h.resolvedHostname || '', asn))
  }
  // 命中目标地址者标 target; 若都没命中, 把最后一跳当落地(不强标 target, 目标靶标仍由 onInit 的 target 画)
  const hit = out.find(o => o.ip === tgtIp)
  if (hit) hit.isTarget = true
  return out
}
function mkHop(idx, ip, g, rtt, loss, isTarget, name, asn) {
  return {
    idx, ip, asn: asn ?? g.asn ?? 0, name: name || asnName(g.asn) || '',
    cc: g.cc || '', city: g.city || '', lat: g.lat, lon: g.lon,
    rtt: rtt == null ? null : rtt, loss: Math.round(loss || 0), isTarget: !!isTarget,
  }
}
// 到目标的逐包 RTT 样本(光谱小点): mtr/traceroute 取目标跳 timings; ping 取顶层 timings。
function roundsOf(res, type) {
  const r = res.result || {}
  let timings = r.timings
  if (type !== 'ping') {
    const hops = r.hops || []
    const last = hops.length ? hops[hops.length - 1] : null
    timings = (last && last.timings) || []
  }
  return (timings || []).map(t => t.rtt).filter(x => x != null).map(x => Math.round(x * 10) / 10)
}

// ── 流式跟踪(POST + 轮询)─────────────────────────────────────────────────────
const POLL_MS = 500
export function streamTrace(target, locations, handlers = {}, opts = {}) {
  const { onInit, onHop, onProbeDone, onUpdate, onDone, onError } = handlers
  let cancelled = false, timer = null
  let inited = false
  const sent = []     // 每个 probe 已下发的 hop 数 + 本轮是否已完结回调
  let targetIp = null
  let firstId = null  // 首轮 measurement id; 无尽 ping 后续轮把它当 locations(字符串)复用同一批探测点
  const infinite = !!opts.infinite && opts.type === 'ping'   // 无尽仅 ping
  const schedule = (fn, ms) => { timer = setTimeout(() => { if (!cancelled) fn() }, ms) }

  // 摄取一次 API 快照: 首轮建骨架(onInit)+ 逐跳追加(onHop)+ 完成(onProbeDone);
  // 无尽后续轮(isRerun): 每个 probe 完结时整条刷新 + 累加该轮样本(onUpdate)。
  async function ingest(d, isRerun) {
    const results = d.results || []
    if (!results.length) return
    if (!inited) {
      // 目标坐标: 取首个解析出地址的 probe(anycast/GeoDNS 下各 probe 可能不同, 取其一画靶标)。
      targetIp = results.find(r => r.result?.resolvedAddress)?.result.resolvedAddress || target
      const tg = await resolveGeo(targetIp)
      const probes = results.map((res, i) => probeMeta(res, i))
      probes.forEach((_, i) => { sent[i] = { n: 0, done: false } })
      onInit && onInit({
        target: tg && tg.lat != null
          ? { ip: targetIp, label: target, lat: tg.lat, lon: tg.lon, cc: tg.cc, city: tg.city || ccLabel(tg.cc) || '', loc: tg.place || tg.city || ccLabel(tg.cc) || '' }
          : { ip: targetIp, label: target, lat: 0, lon: 0, cc: '', city: '', loc: '' },
        probes,
      })
      inited = true
    }
    for (let i = 0; i < results.length; i++) {
      const res = results[i], st = res.result?.status
      const hops = await buildHops(res, opts.type, targetIp)
      const id = 'p' + i
      const s = sent[i] || (sent[i] = { n: 0, done: false })
      const fin = st === 'finished' || st === 'failed'     // failed=探测点离线/出错, 也算完结(否则卡片一直转圈)
      if (isRerun) { if (fin && !s.done) { s.done = true; onUpdate && onUpdate(id, hops, roundsOf(res, opts.type)) }; continue }
      for (let k = s.n; k < hops.length; k++) onHop && onHop(id, hops[k])
      s.n = hops.length
      if (fin && !s.done) { s.done = true; onProbeDone && onProbeDone(id, { rounds: roundsOf(res, opts.type) }) }
    }
  }

  // 跑一轮 measurement。首轮 roundLoc=locations 数组(选探测点); 无尽后续轮 roundLoc=firstId 串(复用同批探测点)。
  async function runRound(roundLoc, isRerun) {
    if (isRerun) for (const s of sent) if (s) s.done = false   // 重置本轮完结标记
    let mid
    try { const m = await createMeasurement(buildBody(target, roundLoc, opts)); mid = m.id }
    catch (e) { onError && onError(e); return }
    if (!firstId) firstId = mid
    const poll = async () => {
      if (cancelled) return
      let d
      try { d = await getMeasurement(mid) } catch { schedule(poll, POLL_MS * 2); return }
      if (cancelled) return
      try { await ingest(d, isRerun) } catch { /* 单次摄取失败不杀轮询 */ }
      if (cancelled) return
      if (d.status === 'finished') {
        // 无尽 ping: 本轮 finish 后, 用首轮 id 当 locations 再发一轮(复用同批探测点), 直到 cancel。
        if (infinite) schedule(() => runRound(firstId, true), 400)
        else onDone && onDone()
      } else schedule(poll, POLL_MS)
    }
    poll()
  }

  runRound(locations, false)
  return { cancel() { cancelled = true; clearTimeout(timer) } }
}
