// 全球路由跟踪 3D 地球引擎(canvas)。
//
// 复用首页 doodle(globe.js)的「地球渲染语言」—— 正交投影 + 大气光晕 + 海岸线 + 经纬网 +
// 夜面城市灯 + 大圆弧 + 数据包,但面向 MTR 可视化整体重做:
//   · 地轴以 23.5° 倾斜(屏幕平面内 roll)→ 像在太空/空间站里俯瞰地球; 缓慢自转; 南极在可见区外。
//   · 数据 = 若干监测点(globalping vantage points)+ 各自到目标的「逐跳(hop)链」。
//   · 随 MTR 逐跳返回,大圆弧逐跳「生长」; 每轮探测有一道彗星「探测波」从监测点扫向当前最远跳;
//     建好的路径上持续有数据包朝目标流动 → 多监测点的彩色路径汇聚到同一个脉冲靶标。
//
// createTraceGlobe(canvas, { tip, hit, onpick, onhover }) ->
//   { setData(model), focus(probeId|null), recenter(), destroy() }
//   model 形状见 globalping.js streamTrace 注释(target + probes[].hops[])。
import worldLand from './world-land.js'
import { geoOrthographic, geoPath, geoArea } from 'd3-geo'

const D2R = Math.PI / 180
const TAU = Math.PI * 2
const clamp = (v, a, b) => v < a ? a : v > b ? b : v

// 地轴倾斜角(像照片里的地球)。负值 = 北极朝右倾(因左侧有 panel, 让地球向右偏更协调)。
const TILT = -23.5 * D2R
const COS_T = Math.cos(TILT), SIN_T = Math.sin(TILT)
const LIFT = 1.025          // 弧线/节点略微抬离球面, 不被球体挡住

// ── 陆地多边形(GeoJSON MultiPolygon, 模块级构建一次)──
// 陆地填充的半球裁剪不再手写(球缘缝合的 winding 极易出错), 交给 d3-geo 的 clipCircle。
// d3 按**球面 winding** 判定多边形内外: 环面积 > 2π(超过半球)即方向反了, 会被解释成补集
// (填出海洋/整圆盘 → 拖动时"反色")。这里逐环用 geoArea 归一化, 保证 fill 永远是陆地本身。
const LAND = (() => {
  const polys = []
  for (const ring of worldLand) {
    let r = ring
    if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r = [...r, r[0]]
    if (geoArea({ type: 'Polygon', coordinates: [r] }) > TAU) r = [...r].reverse()
    polys.push([r])
  }
  return { type: 'MultiPolygon', coordinates: polys }
})()

function toRgb(s) {
  s = (s || '').trim()
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.replace(/^#/, ''))
  if (m) return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16)
  m = /rgba?\(([^)]+)\)/.exec(s)
  if (m) return m[1].split(',').slice(0, 3).map(x => Math.round(parseFloat(x))).join(',')
  return '128,128,128'
}
function shortIp(ip) {
  if (!ip || !ip.includes(':')) return ip || ''
  const g = ip.split(':'); if (g.length <= 4) return ip
  return g.slice(0, 2).join(':') + '…' + g.slice(-2).join(':')
}

export function createTraceGlobe(canvas, opts = {}) {
  const ctx = canvas.getContext('2d')
  const tipEl = opts.tip || null
  const onpick = opts.onpick || null
  const onhover = opts.onhover || null
  const onlochover = opts.onlochover || null  // 悬停/点击探测点光点 → (loc|null, sx, sy); 组件据此弹交互 popup
  let hold = false                            // 外部(popup 打开时)暂停自转, 让光点不漂移
  const surf = opts.hit || canvas
  const root = document.documentElement

  let W = 0, H = 0, DPR = 1, R = 0, Rbase = 0, cx = 0, cy = 0
  let zoom = 1                     // 滚轮缩放(像谷歌地球): 实际 R = Rbase * zoom
  function resize() {
    const w = canvas.offsetWidth, h = canvas.offsetHeight
    if (!w || !h) return
    DPR = Math.min(window.devicePixelRatio || 1, 2)
    W = w; H = h
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    // 地球占满整个视图、球心在 3D 空间里推到偏右(~57% 宽处); 半径取到能盖住最远的视口角 ——
    // 这样默认看不到任何圆盘边缘, 也就不存在「地球底色 ≠ 页面底色」的割裂(浅色尤甚)。缩小(滚轮)后才露球缘。
    cx = W * 0.57; cy = H * 0.5
    const farX = Math.max(cx, W - cx), farY = Math.max(cy, H - cy)
    Rbase = Math.hypot(farX, farY) * 1.04
    R = Rbase * zoom
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

  const css = n => getComputedStyle(root).getPropertyValue(n).trim()
  function palette() {
    const bg = toRgb(css('--bg')).split(',').map(Number)
    const isDark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 110
    return {
      accentRgb: toRgb(css('--accent')), signalRgb: toRgb(css('--signal')),
      muted: css('--muted'), panel: css('--panel'), fg: css('--fg'), sans: css('--sans'),
      glassRgb: isDark ? '224,242,238' : '255,255,255',
      atmoRgb: isDark ? '150,205,255' : '120,175,225',
      landRgb: isDark ? '92,124,140' : '96,124,148',
      isDark,
    }
  }

  // 夜面城市灯近似(同 globe.js): 抽稀海岸线顶点 + 确定性亮度抖动。
  // ── 探测点「光点」: 全部可用监测点位置(取代旧的装饰城市灯)。亮度 ∝ count, 选中高亮; 可 hover/点击 ──
  let locations = []           // [{ id, la, lo, city, cc, country, count, sel }]  ← setLocations 注入
  const locHits = []           // 本帧各光点屏幕位置(供命中检测)

  // ── 相机: 缓慢自转 + 新 trace 时缓飞到目标经度 ──
  const BASE_LAT = 22 * D2R
  let viewLon = 0, viewLat = BASE_LAT
  const cam = { tlon: 0, tlat: BASE_LAT, flying: false, flyT: 0 }
  const angDiff = d => { d = (d + Math.PI) % TAU; if (d < 0) d += TAU; return d - Math.PI }

  // ── 投影(含地轴 roll)── 所有几何统一走这里, 倾斜才一致 ──
  function projectLL(lat, lon) {
    const dl = lon - viewLon, cl = Math.cos(lat), sl = Math.sin(lat)
    const cv = Math.cos(viewLat), sv = Math.sin(viewLat), cd = Math.cos(dl)
    const x = cl * Math.sin(dl), y = cv * sl - sv * cl * cd, z = sv * sl + cv * cl * cd
    return { x: x * COS_T - y * SIN_T, y: x * SIN_T + y * COS_T, z }   // 屏幕平面内倾斜
  }

  // ── 数据 ──
  let model = { target: null, probes: [] }
  let target = null            // { la, lo, ip, label, city }
  let probes = []              // [{ ...vp, rgb, hops:[{la,lo,...}], segGrow:[], waveT, waveSeg, nDone }]
  let activeProbe = null       // hover/选中高亮的 probe id(null=全亮)
  const packets = []
  let pktAcc = 0
  let targetKey = null         // 目标稳定键(仅目标真的换了才重新缓飞相机, 不被逐跳更新打断)

  function setData(m) {
    model = m || { target: null, probes: [] }
    const newKey = model.target ? model.target.ip + '@' + model.target.lat + ',' + model.target.lon : null
    const tgChanged = newKey !== targetKey; targetKey = newKey
    target = model.target ? {
      la: model.target.lat * D2R, lo: model.target.lon * D2R,
      ip: model.target.ip, label: model.target.label, city: model.target.city,
    } : null

    // 增量合并: 已存在的 probe 保留生长进度, 仅给「新到的跳」补一条 segGrow=0(从而触发生长动画)。
    const prev = new Map(probes.map(p => [p.id, p]))
    probes = (model.probes || []).map(mp => {
      const old = prev.get(mp.id)
      const rgb = (mp.color || [45, 212, 191]).join(',')
      const hops = (mp.hops || []).map(h => ({ ...h, la: h.lat * D2R, lo: h.lon * D2R }))
      // segGrow[i] = 第 i 段(节点 i-1 → i, 节点 0 视为监测点本身)的生长进度 0..1
      const segGrow = old ? old.segGrow.slice() : []
      while (segGrow.length < hops.length) segGrow.push(0) // 每跳一条入边的生长进度; 新到的跳从 0 开始长
      return {
        ...mp, rgb, hops, segGrow,
        waveT: old ? old.waveT : 0, waveGap: old ? old.waveGap : 0,
        appearT: old ? old.appearT : introT,
      }
    })
    if (model.target && tgChanged) {                     // 新目标 → 相机缓飞过去(经度对中, 纬度夹northern)
      cam.tlon = model.target.lon * D2R
      cam.tlat = clamp(model.target.lat * D2R, 6 * D2R, 46 * D2R)
      cam.flying = true; cam.flyT = 0
    }
  }
  function focus(id) { activeProbe = id || null }
  function recenter() { if (target) { cam.tlon = target.lo; cam.tlat = clamp(target.la, 6 * D2R, 46 * D2R); cam.flying = true; cam.flyT = 0 } }

  // ── 交互(hover 出 tooltip; 点击转发查询)──
  let pointer = { x: -1, y: -1, inside: false }, hover = null, lastHoverId = null, lastLocId = null
  const hitList = []   // 本帧全部可点目标 {sx,sy,rad,payload}; 点击时实时命中(不能用 hover —— 按下即被清)
  const drag = { active: false, lx: 0, ly: 0, moved: 0 }
  function setPointer(e) {
    const r = surf.getBoundingClientRect(), t = e.touches ? e.touches[0] : e
    if (!t) return
    pointer.x = t.clientX - r.left; pointer.y = t.clientY - r.top; pointer.inside = true
  }
  // 指针在 window 上跟踪(不绑在命中层 surf 上): HUD 浮窗盖在地球之上且与之重叠, 鼠标移到浮窗后
  // surf 既收不到 mousemove、也不会触发 mouseleave(指针几何上仍在 surf 框内)→ pointer 冻结在旧坐标,
  // 悬停命中/tooltip 卡在原地不动、地球还停转。故只在「最顶层命中元素正是 surf」时才算 inside。
  const onMove = e => {
    if (e.target === surf) setPointer(e)
    else { pointer.inside = false; pointer.x = pointer.y = -1 }
  }
  const onLeave = () => { pointer.inside = false; pointer.x = pointer.y = -1 }
  const onDown = e => { drag.active = true; drag.moved = 0; drag.lx = e.clientX; drag.ly = e.clientY; surf.classList.add('grabbing'); e.preventDefault() }
  const onWinMove = e => {
    if (!drag.active) return
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly; drag.lx = e.clientX; drag.ly = e.clientY
    drag.moved += Math.abs(dx) + Math.abs(dy)
    viewLon -= dx / R; viewLat = clamp(viewLat + dy / R, -89 * D2R, 89 * D2R)
    cam.flying = false
  }
  const onWinUp = () => { if (drag.active) { drag.active = false; surf.classList.remove('grabbing') } }
  // 触摸: 单指拖动旋转, 双指捏合缩放(像谷歌地球)。(.tg-hit 设 touch-action:none, 不会触发浏览器手势)
  let pinchD = 0
  const touchDist = e => { const a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }
  const onTStart = e => {
    if (e.touches.length >= 2) { pinchD = touchDist(e); drag.active = false; cam.flying = false; return }
    const t = e.touches[0]; if (!t) return; drag.active = true; drag.moved = 0; drag.lx = t.clientX; drag.ly = t.clientY; setPointer(e)
  }
  const onTMove = e => {
    if (e.touches.length >= 2) { const d = touchDist(e); if (pinchD > 0) { zoom = clamp(zoom * (d / pinchD), 0.5, 5.5); pinchD = d } cam.flying = false; return }
    const t = e.touches[0]; if (!t) return
    if (drag.active) { const dx = t.clientX - drag.lx, dy = t.clientY - drag.ly; drag.lx = t.clientX; drag.ly = t.clientY; drag.moved += Math.abs(dx) + Math.abs(dy); viewLon -= dx / R; viewLat = clamp(viewLat + dy / R, -89 * D2R, 89 * D2R); cam.flying = false }
    setPointer(e)
  }
  const onTEnd = e => { if (!e.touches || e.touches.length < 2) pinchD = 0; drag.active = false; pointer.inside = false }
  // 滚轮缩放(像谷歌地球): 朝指针方向放大/缩小; 缩放期间打断自动缓飞
  const onWheel = e => { e.preventDefault(); zoom = clamp(zoom * (e.deltaY < 0 ? 1.12 : 0.892), 0.5, 5.5); cam.flying = false }
  function hitAt(px, py) {       // 实时命中(用上一帧的 hitList, 不受 drag.active 清 hover 影响), 返回命中项
    let bd = 1e9, hit = null
    for (const it of hitList) { const d = (it.sx - px) ** 2 + (it.sy - py) ** 2; if (d < it.rad * it.rad && d < bd) { bd = d; hit = it } }
    return hit
  }
  const onClick = () => {
    if (drag.moved > 6) return
    const it = hitAt(pointer.x, pointer.y)
    if (!it) { onlochover && onlochover(null, 0, 0); return }   // 点空白处 → 关闭 popup(触屏 dismiss 路径)
    const h = it.payload
    if (h.kind === 'loc') { onlochover && onlochover(h.loc, it.sx, it.sy); return }   // 点光点 → 弹/开 popup(触屏入口)
    if (!onpick) return
    if (h.kind === 'hop' && h.node.asn) onpick('AS' + h.node.asn)
    else if (h.kind === 'hop' && h.node.ip) onpick(h.node.ip)
    else if (h.kind === 'target' && target?.ip) onpick(target.ip)
    else if (h.kind === 'probe') onpick('AS' + h.probe.asn)
  }
  window.addEventListener('mousemove', onMove); surf.addEventListener('mouseleave', onLeave)
  surf.addEventListener('mousedown', onDown)
  window.addEventListener('mousemove', onWinMove); window.addEventListener('mouseup', onWinUp)
  surf.addEventListener('touchstart', onTStart, { passive: true }); surf.addEventListener('touchmove', onTMove, { passive: true }); surf.addEventListener('touchend', onTEnd)
  surf.addEventListener('wheel', onWheel, { passive: false })
  surf.addEventListener('click', onClick)

  // ── 弧线(纯大圆 slerp + 抬升)── 倾斜已含在 projectLL 里 ──
  function arcPoint(a, b, t) {
    const pa = projectLL(a.la, a.lo), pb = projectLL(b.la, b.lo)
    let dot = pa.x * pb.x + pa.y * pb.y + pa.z * pb.z; dot = clamp(dot, -1, 1)
    const om = Math.acos(dot), so = Math.sin(om) || 1e-6
    const s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
    const vx = pa.x * s0 + pb.x * s1, vy = pa.y * s0 + pb.y * s1, vz = pa.z * s0 + pb.z * s1
    return { sx: cx + vx * R * LIFT, sy: cy - vy * R * LIFT, vz }
  }
  function drawArc(a, b, rgb, grow, alpha, width) {
    const pa = projectLL(a.la, a.lo), pb = projectLL(b.la, b.lo)
    let dot = clamp(pa.x * pb.x + pa.y * pb.y + pa.z * pb.z, -1, 1)
    const om = Math.acos(dot), so = Math.sin(om) || 1e-6
    const steps = Math.max(2, Math.min(40, Math.round(om / .09)))
    ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.beginPath(); let pen = false
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * grow, s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
      const vx = pa.x * s0 + pb.x * s1, vy = pa.y * s0 + pb.y * s1, vz = pa.z * s0 + pb.z * s1
      if (vz <= -.02) { pen = false; continue }
      const sx = cx + vx * R * LIFT, sy = cy - vy * R * LIFT
      if (pen) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); pen = true }
    }
    ctx.stroke()
  }

  // ── 地球本体(同 globe.js: 暗=夜地球 + 大气 + 城市灯; 亮=抽象玻璃球)──
  function strokeArc(P, fn, t0, t1, steps, aF, aB) {
    let prev = null
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
    ctx.lineWidth = 1
    const aF = P.isDark ? .07 : .11, aB = P.isDark ? .025 : .04
    for (let m = 0; m < 12; m++) { const lon = (m / 12) * TAU; strokeArc(P, lat => projectLL(lat, lon), -80 * D2R, 80 * D2R, 30, aF, aB) }
    for (let p = 1; p < 6; p++) { const lat = (p / 6) * Math.PI - Math.PI / 2; strokeArc(P, lon => projectLL(lat, lon), -Math.PI, Math.PI, 46, aF * .85, aB * .85) }
  }
  // 陆地填色(与海洋深浅区分) —— 半球裁剪整体交给 d3-geo(geoOrthographic 自带 clipAngle(90)
  // 的 clipCircle 缝合), 不再手写球缘缝合。投影参数与 projectLL 严格等价(已数值验证到 1e-13 px):
  //   · rotate([-viewLon, -viewLat]) + translate(cx,cy) + scale(R)  ≡  projectLL 的视点旋转
  //   · 23.5° 地轴倾斜(屏幕平面内 roll)用画布旋转实现: ctx.rotate(-TILT) 绕 (cx,cy)
  // 全部陆地经 geoPath 写进同一个 path、一次 fill(nonzero winding 取并集) → 重叠不叠 alpha,
  // 无"披萨片"反色、无横切弦、无闪烁; 深浅由这里的 fillStyle 一处决定。
  const proj = geoOrthographic().clipAngle(90)
  const landPath = geoPath(proj, ctx)
  function drawLand(P) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    proj.rotate([-viewLon / D2R, -viewLat / D2R]).translate([cx, cy]).scale(R)
    ctx.save()
    ctx.translate(cx, cy); ctx.rotate(-TILT); ctx.translate(-cx, -cy)
    ctx.fillStyle = P.isDark ? 'rgba(30,47,62,.62)' : 'rgba(218,226,225,.5)'
    ctx.beginPath(); landPath(LAND); ctx.fill()
    ctx.restore()

    // 海岸线描边(开放, 不闭合; 只描真实海岸线、不描球缘) —— 用 projectLL 手动剔背面, 单独一遍
    ctx.strokeStyle = P.isDark ? `rgba(${P.landRgb},.6)` : `rgba(${P.accentRgb},.42)`; ctx.lineWidth = 1
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
  function drawAbstractGlobe(P) {
    // 外发光: 仅柔和勾出球的轮廓(渐隐到透明 → 不形成硬圆盘边)
    const glow = ctx.createRadialGradient(cx, cy, R * .72, cx, cy, R * 1.5)
    glow.addColorStop(0, `rgba(${P.accentRgb},.09)`); glow.addColorStop(1, `rgba(${P.accentRgb},0)`)
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, TAU); ctx.fill()

    const hx = cx - R * .32, hy = cy - R * .4
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip()
    // 关键: 不填充任何实心本体 → 页面背景(含点阵网格)直接透过玻璃球, 与 main 背景零色差融合。
    // 仅叠一层半透明高光 + 极淡 accent 边缘塑出球感, 再画经纬/海岸线。
    const body = ctx.createRadialGradient(hx, hy, R * .1, cx, cy, R * 1.05)
    body.addColorStop(0, 'rgba(255,255,255,.5)')        // 左上受光高光(比背景亮 → 球感)
    body.addColorStop(.5, 'rgba(255,255,255,.13)')
    body.addColorStop(.85, `rgba(${P.accentRgb},.05)`)  // 边缘极淡 accent(玻璃感, 非硬边)
    body.addColorStop(1, `rgba(${P.accentRgb},.1)`)
    ctx.fillStyle = body; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    drawGraticule(P); drawLand(P)
    ctx.restore()
    // 玻璃高光边(左上亮 → 右下淡 accent, 不形成完整硬环)
    ctx.save(); ctx.lineWidth = 1.3
    const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
    rim.addColorStop(0, 'rgba(255,255,255,.85)'); rim.addColorStop(.5, `rgba(${P.accentRgb},0)`); rim.addColorStop(1, `rgba(${P.accentRgb},.28)`)
    ctx.strokeStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R - .6, 0, TAU); ctx.stroke(); ctx.restore()
  }
  function drawGlobe(P) {
    if (!P.isDark) { drawAbstractGlobe(P); return }
    const atmo = P.atmoRgb
    // 太空底: 把球周围压暗到接近本体色, 让黑色星球融进页面背景, 不露生硬圆盘边(随缩放一起放大)
    const space = ctx.createRadialGradient(cx, cy, R * .5, cx, cy, R * 1.9)
    space.addColorStop(0, 'rgba(5,8,15,.95)'); space.addColorStop(.52, 'rgba(5,8,15,.92)'); space.addColorStop(1, 'rgba(5,8,15,0)')
    ctx.fillStyle = space; ctx.fillRect(0, 0, W, H)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const haloR = R * 1.4, halo = ctx.createRadialGradient(cx, cy, R * .95, cx, cy, haloR)
    halo.addColorStop(0, `rgba(${atmo},.14)`); halo.addColorStop(.3, `rgba(${atmo},.05)`); halo.addColorStop(1, `rgba(${atmo},0)`)
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, TAU); ctx.fill(); ctx.restore()

    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip()
    ctx.fillStyle = '#05080f'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    const vol = ctx.createRadialGradient(cx - R * .15, cy - R * .18, R * .1, cx, cy, R)
    vol.addColorStop(0, 'rgba(20,38,60,.5)'); vol.addColorStop(.6, 'rgba(10,20,34,.22)'); vol.addColorStop(1, 'rgba(2,5,10,.5)')
    ctx.fillStyle = vol; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    drawGraticule(P); drawLand(P)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const fres = ctx.createRadialGradient(cx, cy, R * .82, cx, cy, R)
    fres.addColorStop(0, `rgba(${atmo},0)`); fres.addColorStop(.85, `rgba(${atmo},.06)`); fres.addColorStop(1, `rgba(${atmo},.24)`)
    ctx.fillStyle = fres; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill(); ctx.restore()
    ctx.restore()

    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = 1.4; ctx.strokeStyle = `rgba(${atmo},.28)`
    ctx.beginPath(); ctx.arc(cx, cy, R - .6, 0, TAU); ctx.stroke(); ctx.restore()
  }

  // 圆角矩形(标签底板)
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
  }

  // 探测点「光点」: 全部可用位置, 亮度/大小 ∝ count(log 标度); 选中=accent 高亮 + 环; hover 加环。
  // 画在路径/节点之下(背景网络感), 同时把屏幕位置压进 locHits 供命中检测。
  function drawLocations(P) {
    locHits.length = 0
    if (!locations.length) return
    for (const L of locations) {
      const p = projectLL(L.la, L.lo); if (p.z <= .04) continue
      const sx = cx + p.x * R, sy = cy - p.y * R, z = clamp(p.z, 0, 1)
      const mag = Math.min(1, Math.log(L.count + 1) / Math.log(60))     // 0..1 越多越亮
      const sel = L.sel > 0
      const isHot = hover && hover.kind === 'loc' && hover.loc.id === L.id
      const col = sel ? P.accentRgb : (P.isDark ? '150,205,255' : '70,130,165')
      const r = (1.3 + mag * 2.4) * (sel ? 1.3 : 1)
      ctx.save(); ctx.globalCompositeOperation = 'lighter'
      const ga = (sel ? .55 : .16 + mag * .24) * z
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4.2)
      glow.addColorStop(0, `rgba(${col},${ga})`); glow.addColorStop(1, `rgba(${col},0)`)
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, r * 4.2, 0, TAU); ctx.fill(); ctx.restore()
      const da = (sel ? .95 : .4 + mag * .42) * z
      ctx.fillStyle = `rgba(${col},${da})`; ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill()
      if (sel || isHot) { ctx.strokeStyle = `rgba(${col},${isHot ? .9 : .55})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(sx, sy, r + (isHot ? 4 : 3), 0, TAU); ctx.stroke() }
      locHits.push({ sx, sy, L })
    }
  }
  function setLocations(list) { locations = (list || []).map(L => ({ ...L, la: L.lat * D2R, lo: L.lon * D2R })) }
  function setHold(h) { hold = !!h }

  // ── 主循环 ──
  let introT = 0, last = performance.now(), raf = 0
  function frame(now) { try { draw(now) } catch (e) { /* 单帧错误不杀循环 */ } raf = requestAnimationFrame(frame) }

  function draw(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now
    introT += dt
    R = Rbase * zoom                 // 应用滚轮缩放
    const P = palette()

    // 相机: 缓飞到目标 → 之后极慢自转(保持纬度)
    if (cam.flying) {
      const k = 1 - Math.exp(-dt * 2.6)
      viewLon += angDiff(cam.tlon - viewLon) * k
      viewLat += (cam.tlat - viewLat) * k
      cam.flyT += dt; if (cam.flyT > 1.7) cam.flying = false
    } else if (!drag.active && !hover && !hold) {
      viewLon += dt * 0.018                       // 自然缓慢自转(悬停节点 / popup 打开时暂停)
    }

    ctx.clearRect(0, 0, W, H)
    drawGlobe(P)
    drawLocations(P)            // 探测点光点(背景网络, 在路径/节点之下)

    // 节点投影缓存 + 推进各 probe 的「逐段生长」
    const GROW = 2.6      // 每段生长速度(越大越快)
    for (const p of probes) {
      const nodes = [{ la: p.lat * D2R, lo: p.lon * D2R }, ...p.hops]   // 监测点 + 各跳
      p._nodes = nodes
      // 已「到达」的跳数 = hops.length; 让 segGrow 朝 1 推进, 形成逐段点亮
      let frontier = -1
      for (let i = 0; i < p.hops.length; i++) {
        // 前一段长成 ~0.6 后,本段才开始(链式生长)
        const prevOk = i === 0 ? true : p.segGrow[i - 1] > .55
        if (prevOk) p.segGrow[i] = clamp(p.segGrow[i] + dt * GROW, 0, 1)
        if (p.segGrow[i] > .02) frontier = i
      }
      p._frontier = frontier
    }

    const dimAll = activeProbe != null
    // 1) 路径弧线(每段按 segGrow 生长; 非激活 probe 压暗)
    for (const p of probes) {
      const nodes = p._nodes; if (!nodes) continue
      const act = !dimAll || activeProbe === p.id
      const baseA = act ? 1 : .14
      for (let i = 0; i < p.hops.length; i++) {
        const g = p.segGrow[i]; if (g <= .001) continue
        const a = nodes[i], b = nodes[i + 1]
        const za = (projectLL(a.la, a.lo).z + projectLL(b.la, b.lo).z) / 2
        const depth = clamp(za * .5 + .5, 0, 1)
        // 底层稍粗的辉光 + 上层亮线
        drawArc(a, b, p.rgb, g, (.10 + depth * .12) * baseA, (act ? 5.5 : 3) * (.5 + depth * .5))
        drawArc(a, b, p.rgb, g, (.5 + depth * .4) * baseA, (act ? 1.7 : 1) * (.7 + depth * .5))
        // 生长中的弧头亮点
        if (g < .999 && i === p._frontier) {
          const tip = arcPoint(a, b, g)
          if (tip.vz > -.02) { ctx.fillStyle = `rgba(255,255,255,${.9 * baseA})`; ctx.beginPath(); ctx.arc(tip.sx, tip.sy, 2.4, 0, TAU); ctx.fill() }
        }
      }
    }

    // 2) MTR「探测波」彗星 + 路径上的持续数据包
    for (const p of probes) {
      const nodes = p._nodes; if (!nodes || p._frontier < 0) continue
      const act = !dimAll || activeProbe === p.id
      const reach = p._frontier + (p.segGrow[p._frontier] || 0)    // 当前可到达的「连续段数」(含分数)
      // 探测波: 周期性从监测点扫到当前最远跳(像 ttl 递增的探测)
      p.waveGap -= dt
      if (p.waveGap <= 0 && reach > .2) { p.waveT = 0; p.waveGap = 1.6 + Math.random() * 1.2 }
      if (p.waveT >= 0) {
        p.waveT += dt * 1.35
        const head = p.waveT * Math.max(1, reach)
        for (let k = 0; k < 5; k++) {                              // 彗尾 5 个点
          const s = head - k * 0.16
          if (s <= 0 || s >= reach) continue
          const si = Math.floor(s), sf = s - si
          if (si >= p.hops.length) continue
          const pt = arcPoint(nodes[si], nodes[si + 1], sf); if (pt.vz <= -.02) continue
          const fade = (1 - k / 5) * (act ? 1 : .3)
          ctx.fillStyle = `rgba(${p.rgb},${.9 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, (3.1 - k * .42), 0, TAU); ctx.fill()
          if (k === 0) { ctx.fillStyle = `rgba(255,255,255,${.95 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, 1.5, 0, TAU); ctx.fill() }
        }
        if (head > reach + .8) p.waveT = -1
      }
    }
    // 持续流量包(只在路径全建好的 probe 上, 朝目标匀速流)
    pktAcc += dt
    while (pktAcc > .5) {
      pktAcc -= .5
      const done = probes.filter(p => p.status === 'done' && p.hops.length)
      if (done.length) { const p = done[Math.floor(Math.random() * done.length)]; packets.push({ p, s: 0, spd: .55 + Math.random() * .25 }) }
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const pk = packets[i], p = pk.p, nodes = p._nodes
      pk.s += pk.spd * dt; if (!nodes || pk.s >= p.hops.length) { packets.splice(i, 1); continue }
      const si = Math.floor(pk.s), sf = pk.s - si
      const pt = arcPoint(nodes[si], nodes[si + 1], sf); if (pt.vz <= -.02) continue
      const act = !dimAll || activeProbe === p.id
      const fade = Math.min(1, Math.min(pk.s, p.hops.length - pk.s) * 3) * (act ? 1 : .35)
      ctx.fillStyle = `rgba(255,255,255,${.95 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, 1.7, 0, TAU); ctx.fill()
      ctx.strokeStyle = `rgba(${p.rgb},${.6 * fade})`; ctx.lineWidth = 1.4; ctx.stroke()
    }

    // 3) hover 命中检测(探测点光点 / 节点 probe / hop / target)。同时把全部可点目标记入 hitList 供点击用。
    let nextHover = null, best = 1e9
    hitList.length = 0
    const test = (sx, sy, rad, payload) => {
      hitList.push({ sx, sy, rad, payload })
      if (!pointer.inside || drag.active) return
      const d = (sx - pointer.x) ** 2 + (sy - pointer.y) ** 2
      if (d < rad * rad && d < best) { best = d; payload.sx = sx; payload.sy = sy; nextHover = payload }
    }
    for (const lh of locHits) test(lh.sx, lh.sy, 10, { kind: 'loc', loc: lh.L })

    // 4) 目标靶标(脉冲环)
    if (target) {
      const pt = projectLL(target.la, target.lo)
      if (pt.z > -.05) {
        const sx = cx + pt.x * R * LIFT, sy = cy - pt.y * R * LIFT
        const pulse = (introT * .9) % 1
        ctx.save(); ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = `rgba(${P.signalRgb},${(1 - pulse) * .55})`; ctx.lineWidth = 1.6
        ctx.beginPath(); ctx.arc(sx, sy, 6 + pulse * 22, 0, TAU); ctx.stroke()
        ctx.strokeStyle = `rgba(${P.signalRgb},${(1 - ((pulse + .5) % 1)) * .35})`; ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.arc(sx, sy, 6 + ((pulse + .5) % 1) * 22, 0, TAU); ctx.stroke()
        ctx.restore()
        // 十字准星 + 实心靶心
        ctx.strokeStyle = `rgba(${P.signalRgb},.9)`; ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.moveTo(sx - 9, sy); ctx.lineTo(sx - 4, sy); ctx.moveTo(sx + 4, sy); ctx.lineTo(sx + 9, sy)
        ctx.moveTo(sx, sy - 9); ctx.lineTo(sx, sy - 4); ctx.moveTo(sx, sy + 4); ctx.lineTo(sx, sy + 9); ctx.stroke()
        ctx.fillStyle = css('--signal') || '#fbbf24'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, TAU); ctx.fill()
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx - 1, sy - 1, 1.3, 0, TAU); ctx.fill()
        target._sx = sx; target._sy = sy; target._vis = pt.z > .04
        test(sx, sy, 16, { kind: 'target' })
      } else target._vis = false
    }

    // 5) 跳节点(小圆点, 按 probe 色)+ 监测点(发光大点 + 城市标签)
    for (const p of probes) {
      const nodes = p._nodes; if (!nodes) continue
      const act = !dimAll || activeProbe === p.id
      // 中途跳
      for (let i = 0; i < p.hops.length; i++) {
        if (p.segGrow[i] < .9 || p.hops[i].isTarget) continue
        const n = p.hops[i], pt = projectLL(n.la, n.lo); if (pt.z <= .02) continue
        const sx = cx + pt.x * R * LIFT, sy = cy - pt.y * R * LIFT
        const a = (act ? .85 : .25) * clamp((pt.z) * 3, .2, 1)
        ctx.fillStyle = `rgba(${p.rgb},${a})`; ctx.beginPath(); ctx.arc(sx, sy, 2.4, 0, TAU); ctx.fill()
        test(sx, sy, 11, { kind: 'hop', node: n, probe: p })
      }
      // 监测点
      const pp = projectLL(p.lat * D2R, p.lon * D2R)
      if (pp.z > -.02) {
        const sx = cx + pp.x * R * LIFT, sy = cy - pp.y * R * LIFT
        p._sx = sx; p._sy = sy; p._vis = pp.z > .04
        const appear = clamp((introT - p.appearT) / .5, 0, 1)
        const r = 4.6 * appear
        const isHot = hover && hover.kind === 'probe' && hover.probe.id === p.id
        const a = (act ? 1 : .4) * appear
        ctx.save(); ctx.globalCompositeOperation = 'lighter'
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 16)
        glow.addColorStop(0, `rgba(${p.rgb},${.5 * a})`); glow.addColorStop(1, `rgba(${p.rgb},0)`)
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, 16, 0, TAU); ctx.fill(); ctx.restore()
        if (p.status === 'probing') {       // 探测中: 外圈扫描环
          const sp = (introT * 1.4) % 1
          ctx.strokeStyle = `rgba(${p.rgb},${(1 - sp) * .6 * a})`; ctx.lineWidth = 1.3
          ctx.beginPath(); ctx.arc(sx, sy, r + 2 + sp * 12, 0, TAU); ctx.stroke()
        }
        if (isHot) { ctx.strokeStyle = `rgba(${p.rgb},.8)`; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, TAU); ctx.stroke() }
        ctx.fillStyle = `rgb(${p.rgb})`; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill()
        ctx.fillStyle = `rgba(${P.glassRgb},.85)`; ctx.beginPath(); ctx.arc(sx - r * .3, sy - r * .3, r * .34, 0, TAU); ctx.fill()
        ctx.globalAlpha = 1
        test(sx, sy, 13, { kind: 'probe', probe: p })
      } else p._vis = false
    }

    hover = nextHover
    surf.classList.toggle('hot', !!hover)
    // 边沿触发: 仅当「悬停的监测点」变化时回调(不每帧喷 null, 否则会和控制台卡片的 hover-高亮打架)
    const hid = hover && hover.kind === 'probe' ? hover.probe.id : null
    if (onhover && hid !== lastHoverId) { lastHoverId = hid; onhover(hid) }
    // 探测点光点: 边沿触发交给组件弹 DOM popup(可滚动/逐个添加); 不走 canvas tooltip
    const lid = hover && hover.kind === 'loc' ? hover.loc.id : null
    if (onlochover && lid !== lastLocId) { lastLocId = lid; onlochover(lid ? hover.loc : null, hover ? hover.sx : 0, hover ? hover.sy : 0) }

    // 6) tooltip(canvas 外的 DOM, 在 hover 节点上方) —— 仅 probe/hop/target, loc 用组件 popup
    if (tipEl) {
      if (hover && hover.kind !== 'loc') {
        const a = tipEl.querySelector('.tg-a'), b = tipEl.querySelector('.tg-b'), c = tipEl.querySelector('.tg-c')
        if (hover.kind === 'probe') {
          const p = hover.probe
          a.textContent = p.city + ' · ' + p.cc; b.textContent = 'AS' + p.asn + ' ' + (p.network || ''); c.textContent = p.status === 'done' ? `${p.hops.length} hops` : (p.status === 'probing' ? 'probing…' : 'queued')
        } else if (hover.kind === 'target') {
          a.textContent = 'TARGET'; b.textContent = shortIp(target.ip || ''); c.textContent = (target.city || '')
        } else {
          const n = hover.node
          a.textContent = '#' + n.idx + '  ' + shortIp(n.ip || ''); b.textContent = n.asn ? ('AS' + n.asn + ' ' + (n.name || '')) : (n.name || '—'); c.textContent = (n.city ? n.city + ' · ' : '') + (n.rtt != null ? n.rtt + ' ms' : '')
        }
        tipEl.style.left = hover.sx + 'px'; tipEl.style.top = (hover.sy - 8) + 'px'; tipEl.classList.add('on')
      } else tipEl.classList.remove('on')
    }
  }
  raf = requestAnimationFrame(frame)

  return {
    setData, setLocations, setHold, focus, recenter,
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('mousemove', onMove); surf.removeEventListener('mouseleave', onLeave); surf.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onWinMove); window.removeEventListener('mouseup', onWinUp)
      surf.removeEventListener('touchstart', onTStart); surf.removeEventListener('touchmove', onTMove); surf.removeEventListener('touchend', onTEnd)
      surf.removeEventListener('wheel', onWheel); surf.removeEventListener('click', onClick)
    },
  }
}
