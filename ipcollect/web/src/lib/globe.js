// 首页 3D 地球 doodle 引擎(canvas)。从 demo/hero-globe.html 移植, 改为数据驱动 + 接入站点主题色。
//   createGlobe(canvas, { tip, onpick }) -> { setData(origin, routeAsns, loading), destroy() }
//   origin: { ip, lat, lon, line1, line2 } | null   —— 用户来源(连接 IP + 国家质心)
//   routeAsns: number[]                              —— 高亮路由所达的 Tier-1 ASN; 空=连到全部 Tier-1(待机背景)
//   loading: bool                                    —— 引擎/前缀图加载中 → 只亮起点, 加载完才"生长"路由
import worldLand from './world-land.js'
import { TIER1_GEO } from './geo.js'
import { asnName } from './bgp.js'

const D2R = Math.PI / 180
const clamp = (v, a, b) => v < a ? a : v > b ? b : v

// 浮窗里 IPv6 太长 → 只显首尾两组, 中间省略(IPv4/短地址原样)
function shortIp(ip) {
  if (!ip || !ip.includes(':')) return ip || ''
  const g = ip.split(':')
  if (g.length <= 4) return ip
  return g.slice(0, 2).join(':') + '…' + g.slice(-2).join(':')
}

// "#rrggbb" / "rgb(r,g,b)" → "r,g,b"
function toRgb(s) {
  s = (s || '').trim()
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.replace(/^#/, ''))
  if (m) return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16)
  m = /rgba?\(([^)]+)\)/.exec(s)
  if (m) return m[1].split(',').slice(0, 3).map(x => Math.round(parseFloat(x))).join(',')
  return '128,128,128'
}

export function createGlobe(canvas, opts = {}) {
  const ctx = canvas.getContext('2d')
  const tipEl = opts.tip || null
  const onpick = opts.onpick || null
  const wordEl = opts.word || null            // 背景 3D 立体字 PEER.AS(可选)
  const word = { lon: 0, lat: 0, tlon: 0, tlat: 0 }
  let wordDark = null
  const root = document.documentElement

  let W = 0, H = 0, DPR = 1, R = 0, cx = 0, cy = 0
  function resize() {
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height) return
    DPR = Math.min(window.devicePixelRatio || 1, 2)
    W = r.width; H = r.height
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    R = Math.min(W, H) * 0.34
    cx = W / 2; cy = H / 2
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

  const css = n => getComputedStyle(root).getPropertyValue(n).trim()
  function palette() {
    const bg = toRgb(css('--bg')).split(',').map(Number)
    const lum = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2])
    const isDark = lum < 110
    return {
      accentRgb: toRgb(css('--accent')),
      signalRgb: toRgb(css('--signal')),
      muted: css('--muted'), panel: css('--panel'), sans: css('--sans'),
      glassRgb: isDark ? '224,242,238' : '255,255,255',
      isDark,
    }
  }
  // 节点配色: 起点=绿, 路由/其余 Tier-1=淡绿(尺寸/透明度再分层)
  function nodeColor(P, rel) {
    if (rel === 'self') return P.isDark ? ['52,211,153', '#34d399'] : ['5,150,105', '#059669']
    return P.isDark ? ['134,231,196', '#86e7c4'] : ['95,178,140', '#5fb28c']
  }

  const BASE_LAT = 44 * D2R, SUN = { lat: 16 * D2R, lon: -28 * D2R }, LIFT = 1.02
  let viewLon = 0, viewLat = BASE_LAT
  const cam = { tlon: 0, tlat: BASE_LAT, flying: false, flyT: 0 }   // 相机目标(切到用户位置)
  let flewTo = null
  const angDiff = d => { d = (d + Math.PI) % (2 * Math.PI); if (d < 0) d += 2 * Math.PI; return d - Math.PI }
  const regionOf = lon => lon < -30 ? 'NA' : lon < 60 ? 'EU' : 'AP'   // 美洲 / 欧洲 / 亚太

  // ── 数据 ──
  const TIER1 = Object.keys(TIER1_GEO).map(a => ({ asn: +a, ...TIER1_GEO[a] }))
  let N = [], byAsn = {}, ROUTE = [], MESH = []
  let origin = null, loading = false
  const intro = { active: false, endT: 0, fade: 0.35, edgeMap: {} }
  let introT = 0
  const packets = []; let pktAcc = 0, pktAccM = 0

  function gcDist(a, b) {
    const r = D2R, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2
    return Math.asin(Math.min(1, Math.sqrt(h)))
  }

  // route: { asns, entries, adj } | null。节点只放 起点 + 路由经过的 Tier-1(初始空, 不画全量背景)。
  function rebuild(route) {
    const asns = (route && route.asns) || []
    const routeSet = new Set(asns.filter(a => TIER1_GEO[a]))
    const list = []
    if (origin) list.push({ asn: origin.asn ?? -1, name: origin.line1 || '', lat: origin.lat, lon: origin.lon, rel: 'self', isOrigin: true })
    // 有路由后才铺 Tier-1: 路由经过的高亮(route), 其余作为可点击底图(tier1, 末尾淡入)
    if (routeSet.size) for (const t of TIER1) list.push({ asn: t.asn, name: asnName(t.asn) || '', lat: t.lat, lon: t.lon, rel: routeSet.has(t.asn) ? 'route' : 'tier1' })
    N = list.map(a => ({ ...a, ox: 0, oy: 0, vx: 0, vy: 0, sox: 0, soy: 0, bx: 0, by: 0, sx: 0, sy: 0, depth: 0, vis: 1, scl: 1, pres: 0 }))
    byAsn = {}; N.forEach(n => { byAsn[n.isOrigin ? 'ORIGIN' : n.asn] = n })

    ROUTE = []; MESH = []
    if (origin && routeSet.size) {
      // 路由(亮): 起点 → 入口 Tier-1 + Tier-1 间链路
      const inSet = a => routeSet.has(a) && byAsn[a]
      const entries = (route.entries || []).filter(inSet)
      const rseen = new Set()
      const addR = (a, b) => { const k = a + '>' + b; if (!rseen.has(k)) { rseen.add(k); ROUTE.push([a, b]) } }
      for (const e of (entries.length ? entries : [...routeSet])) addR('ORIGIN', e)
      for (const [a, b] of (route.adj || [])) if (inSet(a) && inSet(b)) addR(a, b)

      // 区域 mesh(浅): 同区域内最近邻互连; 跨区域仅取最近的 1~2 条(全连很丑)
      const t1 = N.filter(n => !n.isOrigin)
      const byReg = { NA: [], EU: [], AP: [] }
      for (const n of t1) byReg[regionOf(n.lon)].push(n)
      const routeKeys = new Set(ROUTE.filter(([a]) => a !== 'ORIGIN').map(([a, b]) => a < b ? a + '_' + b : b + '_' + a))
      const mseen = new Set()
      const addM = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (mseen.has(k) || routeKeys.has(k)) return; mseen.add(k); MESH.push([a, b]) }
      for (const reg in byReg) {
        const arr = byReg[reg]
        for (const n of arr) for (const o of arr.filter(x => x !== n).sort((x, y) => gcDist(n, x) - gcDist(n, y)).slice(0, 2)) addM(n.asn, o.asn)
      }
      let cross = 0
      for (const [r1, r2] of [['EU', 'NA'], ['EU', 'AP'], ['NA', 'AP']]) {
        if (cross >= 2 || !byReg[r1].length || !byReg[r2].length) continue
        let best = null, bd = Infinity
        for (const a of byReg[r1]) for (const b of byReg[r2]) { const d = gcDist(a, b); if (d < bd) { bd = d; best = [a.asn, b.asn] } }
        if (best) { addM(best[0], best[1]); cross++ }
      }
    }
    buildIntro()
  }

  function buildIntro() {
    intro.edgeMap = {}
    // 阶段1: 路由边按 BFS(起点→入口→…)生长
    const GAP = 0.16, DUR = 0.5, STAGGER = 0.06
    const reveal = { ORIGIN: 0 }
    const remaining = ROUTE.slice()
    let guard = 0
    while (remaining.length && guard++ < 40) {
      const ready = remaining.filter(e => reveal[e[0]] !== undefined)
      if (!ready.length) break
      const bySrc = {}
      for (const e of ready) (bySrc[e[0]] = bySrc[e[0]] || []).push(e)
      for (const s in bySrc) bySrc[s].forEach((e, i) => {
        const st = reveal[e[0]] + GAP + i * STAGGER, en = st + DUR
        intro.edgeMap[e[0] + '_' + e[1]] = { st, en }
        if (reveal[e[1]] === undefined || reveal[e[1]] > en) reveal[e[1]] = en
      })
      for (const e of ready) remaining.splice(remaining.indexOf(e), 1)
    }
    const routeEnds = Object.values(intro.edgeMap).map(e => e.en)
    const routeEnd = routeEnds.length ? Math.max(...routeEnds) : 0
    // 阶段2: 区域 mesh 在路由完成后接上
    const MGAP = 0.22, MDUR = 0.5, MSTAG = 0.07
    MESH.forEach((e, i) => { const st = routeEnd + MGAP + i * MSTAG; intro.edgeMap[e[0] + '_' + e[1]] = { st, en: st + MDUR } })
    const allEnds = Object.values(intro.edgeMap).map(e => e.en)
    intro.endT = (allEnds.length ? Math.max(...allEnds) : 0) + 0.4
    // 路由节点随其路由边到达; 非路由底图 Tier-1 在路由完成后(随 mesh)淡入
    for (const n of N) { const k = n.isOrigin ? 'ORIGIN' : n.asn; n.revealT = reveal[k] !== undefined ? reveal[k] : routeEnd }
  }

  function setData(o, route, isLoading) {
    const originChanged = JSON.stringify(o) !== JSON.stringify(origin)
    const routeKey = JSON.stringify(route && route.asns ? [route.entries, route.adj, route.asns] : null)
    const changed = originChanged || routeKey !== setData._rk
    setData._rk = routeKey
    origin = o
    loading = !!isLoading
    if (changed) { rebuild(route); introT = 0; intro.active = true }
    if (o && flewTo !== o.ip) {                 // 拿到用户位置 → 相机飞过去(仅首次)
      flewTo = o.ip
      cam.tlon = o.lon * D2R
      cam.tlat = clamp(o.lat * D2R, -50 * D2R, 70 * D2R)
      cam.flying = true; cam.flyT = 0
    }
  }

  // ── 投影 ──
  function projectLL(lat, lon) {
    const dl = lon - viewLon, cl = Math.cos(lat), sl = Math.sin(lat)
    const cv = Math.cos(viewLat), sv = Math.sin(viewLat), cd = Math.cos(dl)
    return { x: cl * Math.sin(dl), y: cv * sl - sv * cl * cd, z: sv * sl + cv * cl * cd }
  }
  const project = a => projectLL(a.lat * D2R, a.lon * D2R)

  // ── 交互 ──
  let pointer = { x: -1, y: -1, inside: false }, hoverIdx = -1
  const drag = { active: false, lx: 0, ly: 0, moved: 0 }
  let originHit = null   // 起点卡片热区(每帧绘制时更新): { ip, asn, dot }
  function hitOrigin(px, py) {
    if (!originHit) return null
    const t = r => r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
    if (t(originHit.asn)) return 'asn'
    if (t(originHit.ip)) return 'ip'
    if (t(originHit.dot)) return 'dot'
    return null
  }
  function setPointer(e) {
    const r = canvas.getBoundingClientRect(), t = e.touches ? e.touches[0] : e
    if (!t) return
    pointer.x = t.clientX - r.left; pointer.y = t.clientY - r.top; pointer.inside = true
  }
  function dragBy(px, py) {
    const dx = px - drag.lx, dy = py - drag.ly; drag.lx = px; drag.ly = py
    drag.moved += Math.abs(dx) + Math.abs(dy)
    viewLon -= dx / R; viewLat = clamp(viewLat + dy / R, -32 * D2R, 86 * D2R)
  }
  const onMove = e => setPointer(e)
  const onLeave = () => { pointer.inside = false; pointer.x = pointer.y = -1 }
  const onDown = e => { drag.active = true; drag.moved = 0; drag.lx = e.clientX; drag.ly = e.clientY; canvas.classList.add('grabbing'); e.preventDefault() }
  const onWinMove = e => {
    if (drag.active) dragBy(e.clientX, e.clientY)
    if (wordEl) {                              // 背景字"按下"视差: 相对地球中心
      const r = canvas.getBoundingClientRect()
      word.tlon = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 1.5), -0.6, 0.6)
      word.tlat = clamp((e.clientY - (r.top + r.height / 2)) / (r.height * 1.5), -0.6, 0.6)
    }
  }
  const onWinUp = () => { if (drag.active) { drag.active = false; canvas.classList.remove('grabbing') } }
  const onTStart = e => { const t = e.touches[0]; if (!t) return; drag.active = true; drag.moved = 0; drag.lx = t.clientX; drag.ly = t.clientY; setPointer(e) }
  const onTMove = e => { const t = e.touches[0]; if (!t) return; if (drag.active) dragBy(t.clientX, t.clientY); setPointer(e) }
  const onTEnd = () => { drag.active = false; pointer.inside = false }
  // 点击时实时命中(不能用 hoverIdx: 按下即 drag.active, hover 检测被跳过, hoverIdx 已被清空)
  function nodeAt(px, py) {
    let hit = -1
    for (let i = 0; i < N.length; i++) {
      const n = N[i]; if (!n.vis || n.isOrigin) continue
      const dx = n.sx - px, dy = n.sy - py, rad = 7 * n.scl + 9
      if (dx * dx + dy * dy < rad * rad && (hit < 0 || n.depth > N[hit].depth)) hit = i
    }
    return hit
  }
  const onClick = () => {
    if (drag.moved > 6 || !onpick) return       // 真拖动才忽略
    const oh = hitOrigin(pointer.x, pointer.y)   // 起点卡: IP→查前缀, ASN→查 ASN, 圆点→查前缀
    if (oh && origin) {
      if (oh === 'asn' && origin.asn) return onpick('AS' + origin.asn)
      if (origin.ip) return onpick(origin.ip)
      return
    }
    const hi = nodeAt(pointer.x, pointer.y)       // Tier-1 → 查 ASN
    if (hi >= 0) onpick('AS' + N[hi].asn)
  }
  canvas.addEventListener('mousemove', onMove)
  canvas.addEventListener('mouseleave', onLeave)
  canvas.addEventListener('mousedown', onDown)
  window.addEventListener('mousemove', onWinMove)
  window.addEventListener('mouseup', onWinUp)
  canvas.addEventListener('touchstart', onTStart, { passive: true })
  canvas.addEventListener('touchmove', onTMove, { passive: true })
  canvas.addEventListener('touchend', onTEnd)
  canvas.addEventListener('click', onClick)

  // ── 绘制 ──
  function strokeArc(P, fn, t0, t1, steps, aF, aB) {
    ctx.lineWidth = 1; let prev = null
    for (let i = 0; i <= steps; i++) {
      const q = fn(t0 + (t1 - t0) * i / steps), sx = cx + q.x * R, sy = cy - q.y * R, vis = q.z > 0
      if (prev && (prev.vis || vis)) {
        ctx.strokeStyle = `rgba(${P.accentRgb},${(prev.vis && vis) ? aF : aB})`
        ctx.beginPath(); ctx.moveTo(prev.sx, prev.sy); ctx.lineTo(sx, sy); ctx.stroke()
      }
      prev = { sx, sy, vis }
    }
  }
  function drawGraticule(P) {
    const aF = P.isDark ? .15 : .12, aB = P.isDark ? .05 : .045
    for (let m = 0; m < 12; m++) { const lon = (m / 12) * Math.PI * 2; strokeArc(P, lat => projectLL(lat, lon), -80 * D2R, 80 * D2R, 30, aF, aB) }
    for (let p = 1; p < 6; p++) { const lat = (p / 6) * Math.PI - Math.PI / 2; strokeArc(P, lon => projectLL(lat, lon), -Math.PI, Math.PI, 46, aF * .85, aB * .85) }
  }
  function drawLand(P) {
    ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.strokeStyle = `rgba(${P.accentRgb},${P.isDark ? .40 : .34})`
    ctx.beginPath()
    for (const ring of worldLand) {
      let pen = false
      for (let i = 0; i < ring.length; i++) {
        const q = projectLL(ring[i][1] * D2R, ring[i][0] * D2R)
        if (q.z > 0) { const sx = cx + q.x * R, sy = cy - q.y * R; if (pen) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); pen = true } }
        else pen = false
      }
    }
    ctx.stroke()
  }
  function drawGlobe(P) {
    const glow = ctx.createRadialGradient(cx, cy, R * .6, cx, cy, R * 1.7)
    glow.addColorStop(0, `rgba(${P.accentRgb},${P.isDark ? .16 : .10})`); glow.addColorStop(1, `rgba(${P.accentRgb},0)`)
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.7, 0, Math.PI * 2); ctx.fill()

    const hx = cx - R * .34, hy = cy - R * .42
    const body = ctx.createRadialGradient(hx, hy, R * .1, cx, cy, R * 1.05)
    if (P.isDark) { body.addColorStop(0, `rgba(${P.glassRgb},.11)`); body.addColorStop(.45, `rgba(${P.glassRgb},.045)`); body.addColorStop(.85, `rgba(${P.accentRgb},.05)`); body.addColorStop(1, `rgba(${P.accentRgb},.02)`) }
    else { body.addColorStop(0, `rgba(${P.glassRgb},.55)`); body.addColorStop(.5, `rgba(${P.glassRgb},.40)`); body.addColorStop(.86, `rgba(${P.accentRgb},.08)`); body.addColorStop(1, `rgba(${P.accentRgb},.04)`) }
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip()
    ctx.fillStyle = P.isDark ? 'rgba(15,26,40,.9)' : 'rgba(238,243,247,.9)'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.fillStyle = body; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    drawGraticule(P); drawLand(P)
    const sd = projectLL(SUN.lat, SUN.lon), slen = Math.hypot(sd.x, sd.y) || 1e-3
    const ux = sd.x / slen, uy = sd.y / slen, edge = 1 - Math.max(0, sd.z)
    const bx = cx + ux * R, by = cy + uy * R, dx = cx - ux * R, dy = cy - uy * R
    const night = P.isDark ? '4,14,20' : '15,42,55', nA = (P.isDark ? .26 : .14) * (.45 + .55 * edge)
    const term = ctx.createLinearGradient(dx, dy, bx, by)
    term.addColorStop(0, `rgba(${night},${nA})`); term.addColorStop(.45, `rgba(${night},${nA * .4})`)
    term.addColorStop(.62, 'rgba(0,0,0,0)'); term.addColorStop(1, `rgba(${P.accentRgb},${P.isDark ? .06 : .05})`)
    ctx.fillStyle = term; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore()

    ctx.save(); ctx.lineWidth = 1.4
    const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
    rim.addColorStop(0, `rgba(${P.glassRgb},${P.isDark ? .5 : .9})`); rim.addColorStop(.5, `rgba(${P.accentRgb},0)`); rim.addColorStop(1, `rgba(${P.accentRgb},${P.isDark ? .4 : .3})`)
    ctx.strokeStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R - .5, 0, Math.PI * 2); ctx.stroke(); ctx.restore()

    const spec = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * .5)
    spec.addColorStop(0, `rgba(${P.glassRgb},${P.isDark ? .10 : .30})`); spec.addColorStop(1, `rgba(${P.glassRgb},0)`)
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = spec; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore()
  }

  function edgePointAt(a, b, t) {
    const pa = project(a), pb = project(b)
    const oaX = a.sx - (cx + pa.x * R * LIFT), oaY = a.sy - (cy - pa.y * R * LIFT)
    const obX = b.sx - (cx + pb.x * R * LIFT), obY = b.sy - (cy - pb.y * R * LIFT)
    let dot = pa.x * pb.x + pa.y * pb.y + pa.z * pb.z; dot = dot < -1 ? -1 : dot > 1 ? 1 : dot
    const om = Math.acos(dot), so = Math.sin(om) || 1e-6, s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
    const vx = pa.x * s0 + pb.x * s1, vy = pa.y * s0 + pb.y * s1, vz = pa.z * s0 + pb.z * s1
    return { sx: cx + vx * R * LIFT + oaX + (obX - oaX) * t, sy: cy - vy * R * LIFT + oaY + (obY - oaY) * t, vz }
  }
  function drawEdge(a, b, P, kind, grow = 1) {
    if (!a || !b || (!a.vis && !b.vis)) return
    const pa = project(a), pb = project(b)
    const oaX = a.sx - (cx + pa.x * R * LIFT), oaY = a.sy - (cy - pa.y * R * LIFT)
    const obX = b.sx - (cx + pb.x * R * LIFT), obY = b.sy - (cy - pb.y * R * LIFT)
    let dot = pa.x * pb.x + pa.y * pb.y + pa.z * pb.z; dot = dot < -1 ? -1 : dot > 1 ? 1 : dot
    const om = Math.acos(dot), so = Math.sin(om) || 1e-6, steps = Math.max(2, Math.min(28, Math.round(om / .12)))
    const z = ((a.depth * .5 + .5) + (b.depth * .5 + .5)) / 2
    const lit = hoverIdx >= 0 && (N[hoverIdx] === a || N[hoverIdx] === b)
    let w, alpha
    const col = P.accentRgb
    if (kind === 'mesh') { alpha = (.05 + z * .10) * (a.vis && b.vis ? 1 : .30); if (lit) alpha += .18; w = lit ? 1.6 : (.5 + z * .5) }
    else { alpha = (.30 + z * .42) * (a.vis && b.vis ? 1 : .40); if (lit) alpha = Math.min(1, alpha + .22); w = lit ? 3.2 : (1.2 + z * .7) }
    alpha *= .25 + .75 * Math.min(a.pres, b.pres)
    ctx.strokeStyle = `rgba(${col},${alpha})`; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.beginPath(); let pen = false, tx = 0, ty = 0, tip = false
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * grow, s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
      const vx = pa.x * s0 + pb.x * s1, vy = pa.y * s0 + pb.y * s1, vz = pa.z * s0 + pb.z * s1
      if (vz <= -.02) { pen = false; continue }
      const ox = oaX + (obX - oaX) * t, oy = oaY + (obY - oaY) * t, sx = cx + vx * R * LIFT + ox, sy = cy - vy * R * LIFT + oy
      if (pen) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); pen = true }
      tx = sx; ty = sy; tip = true
    }
    ctx.stroke()
    if (grow < .999 && tip) { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(tx, ty, 2, 0, Math.PI * 2); ctx.fill() }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
  }

  let last = performance.now(), raf = 0
  function frame(now) {
    try { draw(now) } catch (e) { /* 单帧错误不杀死循环 */ }
    raf = requestAnimationFrame(frame)
  }
  function draw(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now
    const P = palette()
    const reveal = intro.active
    if (reveal) { introT += dt; if (introT > intro.endT + 1.2) intro.active = false }

    // 相机: 飞向用户位置 → 到位后缓慢自转(并保持在用户纬度)
    if (cam.flying) {
      const k = 1 - Math.exp(-dt * 3.2)
      viewLon += angDiff(cam.tlon - viewLon) * k
      viewLat += (cam.tlat - viewLat) * k
      cam.flyT += dt
      if (cam.flyT > 1.6) cam.flying = false
    } else if (!drag.active && !pointer.inside) {
      viewLon += dt * .12
      viewLat += (cam.tlat - viewLat) * (1 - Math.exp(-dt * 2))
    }

    // 背景立体字: 主题色 + 光标侧"按下/下沉"
    if (wordEl) {
      if (wordDark !== P.isDark) {
        wordDark = P.isDark
        wordEl.style.setProperty('--w1', P.isDark ? '#6a85a3' : '#8ca0b3')
        wordEl.style.setProperty('--w1e', P.isDark ? '#26333f' : '#74879a')
        wordEl.style.setProperty('--w2', P.isDark ? '#d0a464' : '#cf9f63')
        wordEl.style.setProperty('--w2e', P.isDark ? '#4d3a23' : '#b58a55')
      }
      word.lon += (word.tlon - word.lon) * .07
      word.lat += (word.tlat - word.lat) * .07
      wordEl.style.transform = `rotateX(${(-word.lat * 16).toFixed(2)}deg) rotateY(${(word.lon * 16).toFixed(2)}deg)`
    }

    ctx.clearRect(0, 0, W, H)
    drawGlobe(P)

    // 1) 投影 + 风弹簧
    const K = 26, DAMP = 5.2
    for (const n of N) {
      const p = project(n)
      n.depth = p.z; n.vis = p.z > -.005 ? 1 : 0; n.scl = .55 + (p.z * .5 + .5) * .6
      let pr = clamp((p.z - .02) / .26, 0, 1); n.pres = pr * pr * (3 - 2 * pr)
      n.bx = cx + p.x * R * LIFT; n.by = cy - p.y * R * LIFT
      const ax = -K * n.ox - DAMP * n.vx, ay = -K * n.oy - DAMP * n.vy
      n.vx += ax * dt; n.vy += ay * dt; n.ox += n.vx * dt; n.oy += n.vy * dt
    }
    // 2) 去重斥力 + hover 绽开
    const SEP = 26, PUSH = 11, PULL = .42, CAP = 30, BLOOM_R = 50, BLOOM_K = 2, relax = 1 - Math.exp(-dt * 9)
    const h = (hoverIdx >= 0 && N[hoverIdx] && N[hoverIdx].vis) ? N[hoverIdx] : null
    const hX = h ? h.bx + h.sox : 0, hY = h ? h.by + h.soy : 0
    for (const n of N) {
      if (!n.vis) { n.sox -= n.sox * relax; n.soy -= n.soy * relax; continue }
      if (n === h) continue
      let fx = 0, fy = 0; const xi = n.bx + n.sox, yi = n.by + n.soy
      for (const m of N) {
        if (m === n || !m.vis) continue
        const dx = xi - (m.bx + m.sox), dy = yi - (m.by + m.soy), d2 = dx * dx + dy * dy
        if (d2 < SEP * SEP && d2 > .01) { const d = Math.sqrt(d2), f = (SEP - d) / SEP * m.pres; fx += dx / d * f; fy += dy / d * f }
      }
      if (h) { const dx = xi - hX, dy = yi - hY, d2 = dx * dx + dy * dy; if (d2 < BLOOM_R * BLOOM_R && d2 > .01) { const d = Math.sqrt(d2), f = (BLOOM_R - d) / BLOOM_R * h.pres; fx += dx / d * f * BLOOM_K; fy += dy / d * f * BLOOM_K } }
      n.sox += (fx * PUSH * n.pres - n.sox * (PULL + (1 - n.pres) * 2.2)) * relax
      n.soy += (fy * PUSH * n.pres - n.soy * (PULL + (1 - n.pres) * 2.2)) * relax
      const mag = Math.hypot(n.sox, n.soy); if (mag > CAP) { n.sox = n.sox / mag * CAP; n.soy = n.soy / mag * CAP }
    }
    // 3) 合成
    for (const n of N) { n.sx = n.bx + n.ox + n.sox; n.sy = n.by + n.oy + n.soy }

    // hover 命中(动画/拖拽时不做)
    let hit = -1
    if (pointer.inside && !drag.active && !reveal) {
      for (let i = 0; i < N.length; i++) { const n = N[i]; if (!n.vis || n.isOrigin) continue; const dx = n.sx - pointer.x, dy = n.sy - pointer.y, rad = 7 * n.scl + 9; if (dx * dx + dy * dy < rad * rad && (hit < 0 || n.depth > N[hit].depth)) hit = i }
      if (hit < 0 && hoverIdx >= 0 && N[hoverIdx] && N[hoverIdx].vis) { const n = N[hoverIdx], dx = n.sx - pointer.x, dy = n.sy - pointer.y; if (dx * dx + dy * dy < 26 * 26) hit = hoverIdx }
    }
    hoverIdx = hit
    // hover 命中含起点卡热区(用上一帧的热区, 1 帧延迟无感); 之后重置, 由本帧绘制时重填
    canvas.classList.toggle('hot', hit >= 0 || (pointer.inside && !drag.active && hitOrigin(pointer.x, pointer.y) != null))
    originHit = null

    // 边: mesh(启动末尾淡入) + route(生长)
    // 区域 mesh(浅, 路由完成后才生长) 画在底层
    for (const [x, y] of MESH) {
      const tm = intro.edgeMap[x + '_' + y]
      let grow = 1
      if (reveal) { grow = tm ? clamp((introT - tm.st) / (tm.en - tm.st), 0, 1) : 0; if (grow <= .001) continue }
      drawEdge(byAsn[x], byAsn[y], P, 'mesh', grow)
    }
    // 路由(亮) 在上层
    for (const [x, y] of ROUTE) {
      const tm = intro.edgeMap[x + '_' + y]
      let grow = 1
      if (reveal) { grow = tm ? clamp((introT - tm.st) / (tm.en - tm.st), 0, 1) : 0; if (grow <= .001) continue }
      drawEdge(byAsn[x], byAsn[y], P, 'route', grow)
    }

    // 数据包(动画结束后才发)
    if (!reveal && ROUTE.length) {
      pktAcc += dt
      while (pktAcc > .55) { pktAcc -= .55; const e = ROUTE[Math.floor(Math.random() * ROUTE.length)]; packets.push({ a: e[0], b: e[1], t: 0, spd: .22 + Math.random() * .16 }) }
      pktAccM += dt
      while (pktAccM > 1.7) { pktAccM -= 1.7; const e = MESH[Math.floor(Math.random() * MESH.length)]; if (e) packets.push({ a: e[0], b: e[1], t: 0, spd: .18 + Math.random() * .14 }) }
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const pk = packets[i]; pk.t += pk.spd * dt
      if (pk.t >= 1) { packets.splice(i, 1); continue }
      const a = byAsn[pk.a], b = byAsn[pk.b]; if (!a || !b || (!a.vis && !b.vis)) continue
      const p = edgePointAt(a, b, pk.t); if (p.vz <= -.02) continue
      const fade = Math.min(1, Math.min(pk.t, 1 - pk.t) * 7)
      ctx.fillStyle = `rgba(255,255,255,${.95 * fade})`; ctx.beginPath(); ctx.arc(p.sx, p.sy, 1.7, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = `rgba(8,20,28,${.20 * fade})`; ctx.lineWidth = .7; ctx.stroke()
    }

    // 节点(深度排序) + 起点常驻卡
    const ni = N.map((n, i) => ({ n, i })).sort((a, b) => a.n.depth - b.n.depth)
    for (const { n, i } of ni) {
      if (!n.vis) continue
      let introA = 1
      if (reveal) { introA = clamp((introT - n.revealT) / intro.fade, 0, 1); if (introA <= .001) continue }
      const [rgb, solid] = nodeColor(P, n.rel)
      const r = (n.isOrigin ? 5.6 : n.rel === 'route' ? 4.2 : 2.9) * n.scl * (.5 + .5 * introA)
      const isHot = i === hoverIdx
      let a = (.45 + (n.depth * .5 + .5) * .55) * n.pres * introA
      if (n.rel === 'tier1') a *= .78
      // 起点出现时的定位"波纹"(扩散环)
      if (n.isOrigin && reveal && n.pres > 0) { const rp = clamp(introT / 0.9, 0, 1); if (rp < 1) { ctx.strokeStyle = `rgba(${rgb},${(1 - rp) * .5})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + rp * 26, 0, Math.PI * 2); ctx.stroke() } }
      if (isHot) { ctx.strokeStyle = `rgba(${rgb},.65)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 3.5, 0, Math.PI * 2); ctx.stroke() }
      ctx.fillStyle = solid; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = a * .9; ctx.fillStyle = `rgba(${P.glassRgb},.8)`; ctx.beginPath(); ctx.arc(n.sx - r * .3, n.sy - r * .3, r * .32, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1

      if (n.isOrigin && origin) {
        ctx.globalAlpha = introA
        const l1 = shortIp(origin.line1 || origin.ip || ''), l2 = origin.line2 || ''  // IPv6 只显首尾
        // 行1(IP)用 mono(ASCII 好看); 行2(ASN+运营商, 含中文)用 sans
        const F1 = '600 12px "IBM Plex Mono", ui-monospace, monospace', F2 = '600 11px ' + (P.sans || 'sans-serif')
        ctx.font = F1; const w1 = ctx.measureText(l1).width
        ctx.font = F2; const w2 = ctx.measureText(l2).width
        const padX = 9, padY = 6, gap = 3, lh1 = 14, lh2 = l2 ? 13 : 0
        const boxW = Math.max(w1, w2) + padX * 2, boxH = padY * 2 + lh1 + (l2 ? gap + lh2 : 0)
        const tick = r + 11, bx0 = n.sx - boxW / 2, by0 = n.sy - tick - boxH
        ctx.strokeStyle = `rgba(${rgb},.55)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(n.sx, n.sy - r); ctx.lineTo(n.sx, by0 + boxH); ctx.stroke()
        roundRect(bx0, by0, boxW, boxH, 7); ctx.fillStyle = P.panel; ctx.fill(); ctx.strokeStyle = `rgba(${rgb},.5)`; ctx.lineWidth = 1; ctx.stroke()
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.font = F1; ctx.fillStyle = solid; ctx.fillText(l1, n.sx, by0 + padY + lh1 / 2)
        if (l2) { ctx.font = F2; ctx.fillStyle = P.muted; ctx.fillText(l2, n.sx, by0 + padY + lh1 + gap + lh2 / 2) }
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1
        // 点击热区: IP 行 → 查前缀; ASN 行 → 查 ASN; 圆点 → 查前缀
        originHit = {
          ip: { x: bx0, y: by0 + padY - 2, w: boxW, h: lh1 + 4 },
          asn: (l2 && origin.asn) ? { x: bx0, y: by0 + padY + lh1 + gap - 2, w: boxW, h: lh2 + 4 } : null,
          dot: { x: n.sx - r - 5, y: n.sy - r - 5, w: 2 * r + 10, h: 2 * r + 10 },
        }
      }
    }

    // tooltip
    if (tipEl) {
      if (hoverIdx >= 0 && N[hoverIdx] && !N[hoverIdx].isOrigin) {
        const n = N[hoverIdx]
        tipEl.querySelector('.dg-asn').textContent = 'AS' + n.asn
        tipEl.querySelector('.dg-nm').textContent = n.name || ''
        tipEl.style.left = n.sx + 'px'; tipEl.style.top = (n.sy - 6) + 'px'; tipEl.classList.add('on')
      } else tipEl.classList.remove('on')
    }
  }
  raf = requestAnimationFrame(frame)

  return {
    setData,
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect()
      canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onWinMove); window.removeEventListener('mouseup', onWinUp)
      canvas.removeEventListener('touchstart', onTStart); canvas.removeEventListener('touchmove', onTMove); canvas.removeEventListener('touchend', onTEnd)
      canvas.removeEventListener('click', onClick)
    },
  }
}
