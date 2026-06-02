// 搜索 / insight 逻辑 (从 web_ref/app.js 移植), 结果写入 S。
import { S } from './store.svelte.js'
import { t } from './i18n.js'
import { q, rp, rpList, pathsFileFor, pathsearchFilesForOrigin, pathsearchFilesForOrigins } from './db.js'
import {
  int2ip, parseSeq, sqlStr, ccLabel, regionName, lowCut, lowCutFor, isLowVis, asnName, classifyQuery,
  asnsMatchingName, compilePathQuery, ip2range, ip6Range, parseBest,
} from './bgp.js'

const NAME_CAP = 200   // AS 名称命中的 origin ASN 上限(过多则提示精确化)

// family 单选(S.filters.fam: 'all'|'4'|'6')过滤分片清单: v6 文件路径含 '_v6/'(geo_v6/、pathsearch_v6/)。
function byFam(files) {
  const fam = S.filters?.fam || 'all'
  if (fam === '4') return (files || []).filter(f => !f.includes('_v6/'))
  if (fam === '6') return (files || []).filter(f => f.includes('_v6/'))
  return files || []
}

let _ccMap = { lang: null, map: null }
function ccMap() {
  if (_ccMap.lang === S.lang && _ccMap.map) return _ccMap.map
  const m = {}
  ;(S.meta?.countries || []).forEach(c => { m[ccLabel(c.cc).toLowerCase()] = c.cc; m[c.cc.toLowerCase()] = c.cc })
  _ccMap = { lang: S.lang, map: m }
  return m
}
export function resolveCC(v) {
  v = (v || '').trim(); if (!v) return null
  return ccMap()[v.toLowerCase()] || (/^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null)
}

let _timer = null
export function scheduleSearch(ms = 700) { clearTimeout(_timer); _timer = setTimeout(runSearch, ms) }
export function searchNow() { clearTimeout(_timer); runSearch() }

export async function runSearch() {
  if (!S.ready) return
  const f = S.filters
  // 精确框(子网/express)优先：非空即抢占，其余筛选忽略(并在 UI 禁用)。
  const probe = classifyQuery(f.ip)
  // 精确框是 ASN 时: 设为「主体」并自动展开右侧 ASN 详情面板(whois + 上下游)。其它输入(含 IP/空)清空
  // 主体上下文(影响关闭语义)。已在展示同一 ASN 则不打断(避免点开 prefix 后被搜索拽回)。放在子网早返回之前。
  setSubjectAsn(probe.kind === 'asn' ? probe.asn : null)
  if (probe.kind === 'ipv6' || probe.kind === 'ipv4') return runSubnet(probe, f)
  const boxAsn = probe.kind === 'asn' ? probe.asn : null   // 纯数字 -> origin AS, 可与国家/城市/AS_PATH 叠加

  // AS 名称搜索: 含字母的查询(name), 或带点但非合法 IP 的串(text, 如 amazon.com) -> 反推匹配的 origin ASN
  // (可能多个), 作为 origin 过滤集。
  let nameHit = null
  const nameQ = probe.kind === 'name' ? probe.q : (probe.kind === 'text' ? f.ip.trim() : null)
  if (nameQ != null) {
    nameHit = asnsMatchingName(nameQ, NAME_CAP)
    if (!nameHit.asns.length) {
      S.rows = []; S.mode = 'global'
      S.msg = (S.lang === 'zh' ? `无 ASN 名称匹配 “${nameQ}”` : `no ASN name matches “${nameQ}”`)
      return
    }
  }

  const cc = resolveCC(f.cc)
  const pq = compilePathQuery(f.path)       // AS_PATH 查询(支持 * ? ! 通配/排除); empty=无 path 条件
  const hasPath = !pq.empty
  // origin 过滤集: 来自纯数字框(单个) 或 名称反查(多个); null=不过滤 origin。
  const originAsns = boxAsn != null ? [boxAsn] : (nameHit ? nameHit.asns : null)
  const city = (f.city || '').trim()
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  const inclLow = !!f.incllow

  const w = []
  let fromExpr, cols, isGlobal = false
  if (cc) {
    // 国家视图: v4 + v6 geo working-set 一起读(schema 一致, segs 均为 CIDR 串列表), 显示层合并。
    // 受 family 单选(f.fam: all/4/6)约束: byFam 只留对应 family 的分片。
    const geoFiles = byFam([...(S.meta?.files?.geo?.[cc] || []), ...(S.meta?.files?.geo_v6?.[cc] || [])])
    if (!geoFiles.length) { S.rows = []; S.mode = 'country'; S.msg = t('no_data_cc'); return }
    fromExpr = rpList(geoFiles)
    cols = 'pid, prefix, city, province, plen, origin_asn, n_paths, segs, best_path'
    if (city && S.meta?.cities?.[cc]) w.push(`city = ${sqlStr(city)}`)
  } else {
    if (!hasPath && !originAsns) { S.rows = []; S.mode = 'prompt'; S.msg = ''; return }
    isGlobal = true
    // origin AS 搜索: 只读覆盖这些 ASN 的 pathsearch 分片(按 origin 排序 + 区间索引); 纯 AS_PATH 搜索仍全表扫。
    const psAll = originAsns ? pathsearchFilesForOrigins(originAsns) : pathsearchFilesForOrigin(null)
    const psFiles = psAll === null ? [] : byFam(psAll)   // family 单选过滤
    if (!psFiles.length) {   // 无覆盖分片(origin 不在库, 或被 family 过滤空) -> 空结果, 不下任何文件
      S.rows = []; S.mode = 'global'
      const lbl = originLabel(originAsns, nameHit, nameQ)
      S.msg = (S.lang === 'zh' ? `全表：显示 0 个前缀 · ${lbl}` : `global: 0 prefixes · ${lbl}`)
      return
    }
    fromExpr = rpList(psFiles)
    cols = 'pid, prefix, cc, origin_asn, n_paths, best_path'
  }
  if (hasPath) for (const c of pq.sqlConds('paths_blob')) w.push(c)
  if (originAsns) w.push(originAsns.length === 1 ? `origin_asn = ${originAsns[0]}` : `origin_asn IN (${originAsns.join(',')})`)
  // 低可见阈值按 family 取(结果可能混 v4+v6): prefix 含 ':' 用 v6 阈值, 否则 v4。
  if (!inclLow) w.push(`n_paths >= (CASE WHEN prefix LIKE '%:%' THEN ${Math.ceil(lowCutFor(true))} ELSE ${Math.ceil(lowCutFor(false))} END)`)
  const bestExpr = pq.sqlBest('best_path')
  const order = (bestExpr ? `(${bestExpr}) DESC, ` : '') + 'n_paths DESC'
  const sql = `SELECT ${cols} FROM ${fromExpr} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit + 1}`

  S.msg = (isGlobal && hasPath) ? t('searching_global') : t('querying')
  let rows
  try { rows = await q(sql) } catch (e) { S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit)
  rows.forEach(r => { r._best = !!(pq.hasInclude && pq.testStr(r.best_path)) })
  rows.sort((a, b) => (pq.hasInclude ? (b._best ? 1 : 0) - (a._best ? 1 : 0) : 0) || cmpBy('n_paths', -1, a, b))
  S.rows = rows
  S.mode = cc ? 'country' : 'global'
  S.sortKey = 'n_paths'; S.sortDir = -1

  const N = `${rows.length}${more ? '+' : ''}`
  const scope = cc ? `${ccLabel(cc)}${city ? ' · ' + city : ''}` : t('global')
  const oTxt = originAsns ? ` · ${originLabel(originAsns, nameHit, nameQ)}` : ''
  const pTxt = hasPath ? (S.lang === 'zh' ? ` · path [${pq.summary()}]${pq.hasInclude ? '（★=落在最优路径）' : ''}` : ` · path [${pq.summary()}]${pq.hasInclude ? ' (★=on best path)' : ''}`) : ''
  S.msg = (S.lang === 'zh'
    ? `${scope}：显示 ${N} 个前缀${oTxt}${pTxt}` + (!inclLow ? ' · 已隐藏低可见' : '')
    : `${scope}: ${N} prefixes${oTxt}${pTxt}` + (!inclLow ? ' · low-vis hidden' : ''))
}

// origin 过滤的人类可读标签: 名称搜索显示 “名称→N 个 ASN(列前几个)”, 纯数字显示单个 origin AS。
function originLabel(asns, nameHit, nameQ) {
  if (nameHit && nameQ) {
    const n = asns.length
    const head = asns.slice(0, 6).map(a => 'AS' + a).join(', ')
    const tail = (n > 6 || nameHit.more) ? '…' : ''
    return (S.lang === 'zh'
      ? `名称 “${nameQ}” → ${n}${nameHit.more ? '+' : ''} 个 origin (${head}${tail})`
      : `name “${nameQ}” → ${n}${nameHit.more ? '+' : ''} origins (${head}${tail})`)
  }
  return `origin AS${asns[0]}`
}

async function runSubnet(r, f) {
  S.msg = t('querying')
  const v6 = r.kind === 'ipv6'
  const { start, end, isCidr, plen } = r
  const label = (f.ip || '').trim() || (isCidr ? `${start}/${plen}` : `${start}`)
  // v6: 比较在 SQL 里做(start/end 是 BigInt -> 十进制串 + ::UHUGEINT); 不取回原始 ip 整数(JS 会丢精度)。
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  const src = v6 ? rpList(S.meta?.files?.prefixes_v6 || []) : rp('prefixes')
  if (v6 && !(S.meta?.files?.prefixes_v6 || []).length) { S.rows = []; S.mode = 'subnet'; S.msg = `${label} · ${t('no_cover')}`; return }
  // 区间重叠: 命中覆盖该范围的母段, 以及落在该范围内的更具体段。
  const w = [`ip_start <= ${lit(end)}`, `ip_end >= ${lit(start)}`]
  const cc = resolveCC(f.cc)
  if (cc) w.push(`cc = ${sqlStr(cc)}`)
  const city = (f.city || '').trim()
  if (city) w.push(`city = ${sqlStr(city)}`)
  if (!f.incllow) w.push(`n_paths >= ${Math.ceil(lowCutFor(v6))}`)
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  let rows
  try {
    rows = await q(`SELECT pid, prefix, plen, cc, city, origin_asn, n_paths
      FROM ${src} WHERE ${w.join(' AND ')}
      ORDER BY plen DESC, ip_start LIMIT ${limit + 1}`)
  } catch (e) { S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit)
  S.rows = rows; S.mode = 'subnet'
  const extra = [cc && ccLabel(cc), city, !f.incllow && (S.lang === 'zh' ? '隐藏低可见' : 'low-vis hidden')].filter(Boolean).join(' · ')
  const tail = extra ? ' · ' + extra : ''
  if (!rows.length) { S.msg = `${label}${tail} · ${t('no_cover')}`; return }
  S.msg = `${label} · ${rows.length}${more ? '+' : ''} ${t('subnet_done')}${tail}`
}

export function cmpBy(key, dir, a, b) {
  let x = a[key], y = b[key]
  if (x == null) x = -Infinity; if (y == null) y = -Infinity
  if (typeof x === 'string' || typeof y === 'string') { x = String(x); y = String(y) }
  return x < y ? -dir : (x > y ? dir : 0)
}
export function sortRows(key) {
  if (S.sortKey === key) S.sortDir = -S.sortDir; else { S.sortKey = key; S.sortDir = -1 }
  S.rows = [...S.rows].sort((a, b) => cmpBy(S.sortKey, S.sortDir, a, b))
}

// ---- 详情面板: prefix / asn 视图 + 导航历史 ----
export async function showInsight(pid, prefix, { push = true } = {}) {
  S.detailKind = 'prefix'
  S.asnView = null
  S.selectedPid = pid
  if (push) pushNav({ kind: 'prefix', pid, prefix })
  S.insight = { loading: true }
  const v6 = (prefix || '').includes(':')
  const src = v6 ? rpList(S.meta?.files?.prefixes_v6 || []) : rp('prefixes')
  let det, paths
  try {
    // 不取 ip_start/ip_end(v6 取回 JS 会丢精度); 范围从 prefix 串算。
    det = (await q(`SELECT prefix, plen, origin_asn, n_paths, cc, city, province FROM ${src} WHERE pid=${pid} LIMIT 1`))[0]
    paths = await q(`SELECT path_arr, path_len, n_peers, is_best FROM ${rpList(pathsFileFor(pid))} WHERE pid=${pid} ORDER BY path_len ASC, n_peers DESC`)
  } catch (e) { S.insight = { error: e.message }; return }
  if (!det) { S.insight = { error: 'not found' }; return }
  const rng = v6 ? ip6Range(det.prefix) : ip2range(det.prefix)
  const [sup, sub] = rng ? await relData(pid, rng.start, rng.end, v6) : [[], []]
  S.insight = {
    pid, prefix: det.prefix,
    loc: [det.province, det.city].filter(Boolean).join(' ') || ccLabel(det.cc),
    origin_asn: det.origin_asn, origin_name: asnName(det.origin_asn), n_paths: det.n_paths,
    lowvis: isLowVis(det),
    paths: paths.map(p => ({ asns: Array.from(p.path_arr || []).map(Number), peers: p.n_peers, is_best: p.is_best })),
    sup, sub,
  }
}
// 父子段(更大/更小): v6 用 prefixes_v6 + ::UHUGEINT 字面量(范围在 SQL 里比, 不取回原始整数)。
async function relData(pid, s, e, v6) {
  const src = v6 ? rpList(S.meta?.files?.prefixes_v6 || []) : rp('prefixes')
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    const sup = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start <= ${lit(s)} AND ip_end >= ${lit(e)} AND pid <> ${pid} ORDER BY (ip_end-ip_start) ASC LIMIT 12`)
    const sub = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start >= ${lit(s)} AND ip_end <= ${lit(e)} AND pid <> ${pid} ORDER BY ip_start LIMIT 64`)
    return [sup, sub]
  } catch (e) { return [[], []] }
}
// ── ASN 详情视图(whois 由 Whois.svelte 自取; 这里只算本地 BGP: 通告前缀 + 观测上游) ──────
export async function showAsn(asn, { push = true } = {}) {
  asn = +asn
  S.detailKind = 'asn'
  S.selectedPid = null
  S.insight = null
  S.asnView = { asn, name: asnName(asn), loading: true }
  if (push) pushNav({ kind: 'asn', asn })
  if (!S.ready) { return }
  try {
    const psAll = pathsearchFilesForOrigin(asn)
    const psFiles = psAll === null ? [] : byFam(psAll)
    if (!psFiles.length) {   // 该 ASN 不是库内任何前缀的 origin(可能是纯 transit / 不在库)
      S.asnView = { asn, name: asnName(asn), count4: 0, count6: 0, prefixes: [], upstreams: [], neigh: null }
      return
    }
    const from = rpList(psFiles)
    const [rows, cnt] = await Promise.all([
      q(`SELECT pid, prefix, cc, n_paths, best_path FROM ${from} WHERE origin_asn=${asn} ORDER BY n_paths DESC LIMIT 400`),
      q(`SELECT SUM(CASE WHEN prefix LIKE '%:%' THEN 0 ELSE 1 END) AS c4, SUM(CASE WHEN prefix LIKE '%:%' THEN 1 ELSE 0 END) AS c6 FROM ${from} WHERE origin_asn=${asn}`),
    ])
    S.asnView = {
      asn, name: asnName(asn),
      count4: Number(cnt[0]?.c4 || 0), count6: Number(cnt[0]?.c6 || 0),
      prefixes: rows, upstreams: deriveUpstreams(rows, asn), neigh: null,
    }
  } catch (e) { S.asnView = { asn, name: asnName(asn), error: e.message } }
}
// 从通告前缀的 best_path 推「直接上游」(origin 左侧那一跳), 廉价、随通告前缀一起拿到。
function deriveUpstreams(rows, asn) {
  const m = new Map()
  for (const r of rows) {
    const arr = parseBest(r.best_path)
    const i = arr.lastIndexOf(asn)
    if (i > 0) { const u = arr[i - 1]; if (u && u !== asn) m.set(u, (m.get(u) || 0) + 1) }
  }
  return [...m.entries()].map(([a, n]) => ({ asn: a, n })).sort((a, b) => b.n - a.n).slice(0, 30)
}
// 按需「完整邻居」分析: 全表扫 pathsearch 里所有含该 ASN 的路径, 同时得上游(左)与下游(右)。
// 重(大 transit ASN 命中分片多), 故不自动触发, 由面板按钮触发; LIMIT 兜底防超大。
export async function scanNeighbors(asn) {
  asn = +asn
  if (!S.asnView || S.asnView.asn !== asn) return
  S.asnView = { ...S.asnView, neigh: { loading: true } }
  try {
    const psAll = pathsearchFilesForOrigin(null)
    const psFiles = psAll === null ? [] : byFam(psAll)
    if (!psFiles.length) { S.asnView = { ...S.asnView, neigh: { up: [], down: [], scanned: 0 } }; return }
    const rows = await q(`SELECT paths_blob FROM ${rpList(psFiles)} WHERE paths_blob LIKE '% ${asn} %' LIMIT 20000`)
    const up = new Map(), down = new Map()
    for (const r of rows) {
      for (const path of String(r.paths_blob || '').trim().split('|')) {
        const arr = path.trim().split(/\s+/).map(Number)
        for (let i = 0; i < arr.length; i++) if (arr[i] === asn) {
          if (i > 0 && arr[i - 1] !== asn) up.set(arr[i - 1], (up.get(arr[i - 1]) || 0) + 1)
          if (i < arr.length - 1 && arr[i + 1] !== asn) down.set(arr[i + 1], (down.get(arr[i + 1]) || 0) + 1)
        }
      }
    }
    const top = mp => [...mp.entries()].map(([a, n]) => ({ asn: a, n })).sort((x, y) => y.n - x.n).slice(0, 40)
    S.asnView = { ...S.asnView, neigh: { up: top(up), down: top(down), scanned: rows.length, capped: rows.length >= 20000 } }
  } catch (e) { S.asnView = { ...S.asnView, neigh: { error: e.message } } }
}

// 精确框 ASN -> 设主体 + 自动开面板(主体变化时); 非 ASN -> 清主体。
function setSubjectAsn(asn) {
  if (asn == null) { S.subject = null; return }
  if (S.subject?.kind === 'asn' && S.subject.id === asn && S.detailKind) return  // 已在看, 别打断
  S.subject = { kind: 'asn', id: asn }
  resetNav()
  showAsn(asn)
}

// ── 导航历史(前进/后退) ──────────────────────────────────────────
function pushNav(entry) {
  const n = S.nav
  n.stack = n.stack.slice(0, n.idx + 1)
  n.stack.push(entry)
  n.idx = n.stack.length - 1
}
function resetNav() { S.nav = { stack: [], idx: -1 } }
export function navCanBack() { return S.nav.idx > 0 }
export function navCanFwd() { return S.nav.idx < S.nav.stack.length - 1 }
function renderEntry(e) {
  if (!e) return
  if (e.kind === 'asn') showAsn(e.asn, { push: false })
  else showInsight(e.pid, e.prefix, { push: false })
}
export function navBack() { if (navCanBack()) { S.nav.idx--; renderEntry(S.nav.stack[S.nav.idx]) } }
export function navForward() { if (navCanFwd()) { S.nav.idx++; renderEntry(S.nav.stack[S.nav.idx]) } }

// 智能关闭: 看 prefix 且有 ASN 主体上下文 -> 先返回该 ASN 信息页; 否则真正关闭(再点即关)。
export function closeInsight() {
  if (S.detailKind === 'prefix' && S.subject?.kind === 'asn') { showAsn(S.subject.id); return }
  hardCloseDetail()
}
// 彻底关闭(Esc 用): 不走「先返回 ASN」语义。
export function hardCloseDetail() {
  S.detailKind = null; S.selectedPid = null; S.insight = null; S.asnView = null
  resetNav()
}
