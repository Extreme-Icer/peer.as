// 搜索 / insight 逻辑 (从 web_ref/app.js 移植), 结果写入 S。
import { S } from './store.svelte.js'
import { t } from './i18n.js'
import { q, rp, rpList, pathsFileFor, pathsearchFilesForOrigin, pathsearchFilesForOrigins } from './db.js'
import {
  int2ip, parseSeq, sqlStr, ccLabel, regionName, lowCut, isLowVis, asnName, classifyQuery,
  asnsMatchingName,
} from './bgp.js'

const NAME_CAP = 200   // AS 名称命中的 origin ASN 上限(过多则提示精确化)

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
  if (probe.kind === 'ipv6') { S.rows = []; S.mode = 'subnet'; S.msg = t('v6_soon'); return }
  if (probe.kind === 'ipv4') return runSubnet(probe, f)
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
  const seq = parseSeq(f.path)
  const seqLike = seq.length ? sqlStr('% ' + seq.join(' ') + ' %') : null
  // origin 过滤集: 来自纯数字框(单个) 或 名称反查(多个); null=不过滤 origin。
  const originAsns = boxAsn != null ? [boxAsn] : (nameHit ? nameHit.asns : null)
  const city = (f.city || '').trim()
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  const inclLow = !!f.incllow

  const w = []
  let fromExpr, cols, isGlobal = false
  if (cc) {
    const geoFiles = S.meta?.files?.geo?.[cc] || []
    if (!geoFiles.length) { S.rows = []; S.mode = 'country'; S.msg = t('no_data_cc'); return }
    fromExpr = rpList(geoFiles)
    cols = 'pid, prefix, city, province, plen, origin_asn, n_paths, segs, best_path'
    if (city && S.meta?.cities?.[cc]) w.push(`city = ${sqlStr(city)}`)
  } else {
    if (!seqLike && !originAsns) { S.rows = []; S.mode = 'prompt'; S.msg = ''; return }
    isGlobal = true
    // origin AS 搜索: 只读覆盖这些 ASN 的 pathsearch 分片(按 origin 排序 + 区间索引); 纯 AS_PATH 搜索仍全表扫。
    const psFiles = originAsns ? pathsearchFilesForOrigins(originAsns) : pathsearchFilesForOrigin(null)
    if (psFiles === null) {   // 索引完整且无分片覆盖 -> 这些 origin 都不在库 -> 空结果, 不下任何文件
      S.rows = []; S.mode = 'global'
      const lbl = originLabel(originAsns, nameHit, nameQ)
      S.msg = (S.lang === 'zh' ? `全表：显示 0 个前缀 · ${lbl}` : `global: 0 prefixes · ${lbl}`)
      return
    }
    fromExpr = rpList(psFiles)
    cols = 'pid, prefix, cc, origin_asn, n_paths, best_path'
  }
  if (seqLike) w.push(`paths_blob LIKE ${seqLike}`)
  if (originAsns) w.push(originAsns.length === 1 ? `origin_asn = ${originAsns[0]}` : `origin_asn IN (${originAsns.join(',')})`)
  if (!inclLow) w.push(`n_paths >= ${Math.ceil(lowCut())}`)
  const order = (seqLike ? `(best_path LIKE ${seqLike}) DESC, ` : '') + 'n_paths DESC'
  const sql = `SELECT ${cols} FROM ${fromExpr} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit + 1}`

  S.msg = (isGlobal && seqLike) ? t('searching_global') : t('querying')
  let rows
  try { rows = await q(sql) } catch (e) { S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit)
  const tag = ' ' + seq.join(' ') + ' '
  rows.forEach(r => { r._best = !!(seqLike && r.best_path && r.best_path.includes(tag)) })
  rows.sort((a, b) => (seq.length ? (b._best ? 1 : 0) - (a._best ? 1 : 0) : 0) || cmpBy('n_paths', -1, a, b))
  S.rows = rows
  S.mode = cc ? 'country' : 'global'
  S.sortKey = 'n_paths'; S.sortDir = -1

  const N = `${rows.length}${more ? '+' : ''}`
  const scope = cc ? `${ccLabel(cc)}${city ? ' · ' + city : ''}` : t('global')
  const oTxt = originAsns ? ` · ${originLabel(originAsns, nameHit, nameQ)}` : ''
  S.msg = (S.lang === 'zh'
    ? `${scope}：显示 ${N} 个前缀${oTxt}` + (seq.length ? ` · path 含连续 [${seq.join(' ')}]（★=落在最优路径）` : '') + (!inclLow ? ' · 已隐藏低可见' : '')
    : `${scope}: ${N} prefixes${oTxt}` + (seq.length ? ` · path contains [${seq.join(' ')}] (★=on best path)` : '') + (!inclLow ? ' · low-vis hidden' : ''))
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
  const { start, end, isCidr, plen } = r
  const label = isCidr ? `${int2ip(start)}/${plen}` : int2ip(start)
  // 子网结果可叠加二次筛选(国家/城市/可见度/limit; AS_PATH 因 prefixes 无路径数据不支持)
  const w = [`ip_start <= ${end}`, `ip_end >= ${start}`]
  const cc = resolveCC(f.cc)
  if (cc) w.push(`cc = ${sqlStr(cc)}`)
  const city = (f.city || '').trim()
  if (city) w.push(`city = ${sqlStr(city)}`)
  if (!f.incllow) w.push(`n_paths >= ${Math.ceil(lowCut())}`)
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  let rows
  try {
    // 区间重叠: 命中覆盖该范围的母段, 以及落在该范围内的更具体段。
    rows = await q(`SELECT pid, prefix, ip_start, ip_end, plen, cc, city, origin_asn, n_paths
      FROM ${rp('prefixes')} WHERE ${w.join(' AND ')}
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

// ---- insight ----
export async function showInsight(pid) {
  S.selectedPid = pid
  S.insight = { loading: true }
  let det, paths
  try {
    det = (await q(`SELECT prefix, ip_start, ip_end, plen, origin_asn, n_paths, cc, city, province FROM ${rp('prefixes')} WHERE pid=${pid} LIMIT 1`))[0]
    paths = await q(`SELECT path_arr, path_len, n_peers, is_best FROM ${rpList(pathsFileFor(pid))} WHERE pid=${pid} ORDER BY path_len ASC, n_peers DESC`)
  } catch (e) { S.insight = { error: e.message }; return }
  if (!det) { S.insight = { error: 'not found' }; return }
  const [sup, sub] = await relData(pid, det.ip_start, det.ip_end)
  S.insight = {
    pid, prefix: det.prefix,
    loc: [det.province, det.city].filter(Boolean).join(' ') || ccLabel(det.cc),
    origin_asn: det.origin_asn, origin_name: asnName(det.origin_asn), n_paths: det.n_paths,
    lowvis: isLowVis(det),
    paths: paths.map(p => ({ asns: Array.from(p.path_arr || []).map(Number), peers: p.n_peers, is_best: p.is_best })),
    sup, sub,
  }
}
async function relData(pid, s, e) {
  try {
    const sup = await q(`SELECT pid, prefix, plen FROM ${rp('prefixes')} WHERE ip_start <= ${s} AND ip_end >= ${e} AND pid <> ${pid} ORDER BY (ip_end-ip_start) ASC LIMIT 12`)
    const sub = await q(`SELECT pid, prefix, plen FROM ${rp('prefixes')} WHERE ip_start >= ${s} AND ip_end <= ${e} AND pid <> ${pid} ORDER BY ip_start LIMIT 64`)
    return [sup, sub]
  } catch (e) { return [[], []] }
}
export function closeInsight() { S.selectedPid = null; S.insight = null }
