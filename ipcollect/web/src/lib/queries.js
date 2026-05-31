// 搜索 / insight 逻辑 (从 web_ref/app.js 移植), 结果写入 S。
import { S } from './store.svelte.js'
import { t } from './i18n.js'
import { q, rp, rpList, pathsFileFor } from './db.js'
import {
  ip2int, int2ip, parseSeq, sqlStr, ccLabel, regionName, lowCut, isLowVis, asnName,
} from './bgp.js'

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
export function scheduleSearch(ms = 350) { clearTimeout(_timer); _timer = setTimeout(runSearch, ms) }
export function searchNow() { clearTimeout(_timer); runSearch() }

export async function runSearch() {
  if (!S.ready) return
  const f = S.filters
  const ipq = ip2int(f.ip)
  if (ipq !== null) return runSubnet(ipq)

  const cc = resolveCC(f.cc)
  const seq = parseSeq(f.path)
  const seqLike = seq.length ? sqlStr('% ' + seq.join(' ') + ' %') : null
  const originAsn = /^\d+$/.test((f.origin || '').trim()) ? parseInt(f.origin, 10) : null
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
    if (!seqLike && originAsn == null) { S.rows = []; S.mode = 'prompt'; S.msg = ''; return }
    isGlobal = true
    fromExpr = rp('pathsearch')
    cols = 'pid, prefix, cc, origin_asn, n_paths, best_path'
  }
  if (seqLike) w.push(`paths_blob LIKE ${seqLike}`)
  if (originAsn != null) w.push(`origin_asn = ${originAsn}`)
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
  const oTxt = originAsn != null ? ` · origin AS${originAsn}` : ''
  S.msg = (S.lang === 'zh'
    ? `${scope}：显示 ${N} 个前缀${oTxt}` + (seq.length ? ` · path 含连续 [${seq.join(' ')}]（★=落在最优路径）` : '') + (!inclLow ? ' · 已隐藏低可见' : '')
    : `${scope}: ${N} prefixes${oTxt}` + (seq.length ? ` · path contains [${seq.join(' ')}] (★=on best path)` : '') + (!inclLow ? ' · low-vis hidden' : ''))
}

async function runSubnet(ip) {
  S.msg = t('querying')
  let rows
  try {
    rows = await q(`SELECT pid, prefix, ip_start, ip_end, plen, cc, city, origin_asn, n_paths
      FROM ${rp('prefixes')} WHERE ip_start <= ${ip} AND ip_end >= ${ip} ORDER BY plen DESC`)
  } catch (e) { S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  S.rows = rows; S.mode = 'subnet'
  if (!rows.length) { S.msg = `${int2ip(ip)} · ${t('no_cover')}`; return }
  S.msg = `${int2ip(ip)} · ${rows.length} ${t('subnet_done')}`
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
