// 搜索 / insight 逻辑 (从 web_ref/app.js 移植), 结果写入 S。
import { S } from './store.svelte.js'
import { t } from './i18n.js'
import { q, rpList, pathsFileFor, pathsearchFilesForOrigin, pathsearchFilesForOrigins, prefixesFilesForRange } from './db.js'
import { resolveDns } from './dns.js'
import {
  int2ip, parseSeq, sqlStr, ccLabel, regionName, lowCut, lowCutFor, isLowVis, asnName, classifyQuery,
  asnsMatchingName, compilePathQuery, ip2range, ip6Range, parseBest, placeLabel, classifyRelation, isTier1,
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
  // 域名 -> DNS 解析视图(左:记录, 右:域名详情面板); 抢占其它一切, 自成一支。
  if (probe.kind === 'domain') return runDns(probe.domain)
  S.dns = null   // 离开 DNS 模式: 清空记录, 主内容区回到结果表
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
  const src = rpList(prefixesFilesForRange(start, end, v6))
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

// ── DNS 解析(DoH) + A/AAAA 富集前缀/origin ASN ───────────────────────────────
// 一个 IP -> 库内覆盖它的最具体前缀 + origin ASN(供点击下钻到前缀/ASN 详情)。库内无覆盖则 prefix=null。
async function enrichIp(ip, v6) {
  const r = v6 ? ip6Range(ip) : ip2range(ip)
  if (!r) return { ip }
  if (v6 && !(S.meta?.files?.prefixes_v6 || []).length) return { ip }   // 无 v6 前缀数据集
  const src = rpList(prefixesFilesForRange(r.start, r.end, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    // 覆盖该地址的前缀里取最具体(范围最小)那一条。
    const rows = await q(`SELECT pid, prefix, origin_asn, n_paths FROM ${src}
      WHERE ip_start <= ${lit(r.start)} AND ip_end >= ${lit(r.end)}
      ORDER BY (ip_end - ip_start) ASC LIMIT 1`)
    const m = rows[0]
    if (m) return { ip, pid: m.pid, prefix: m.prefix, asn: m.origin_asn, n_paths: m.n_paths }
  } catch (e) { /* 富集失败不影响记录展示 */ }
  return { ip }
}

// 域名 -> DNS 解析视图。左侧主内容区(DnsView)显示记录, 右侧(桌面)自动展开域名详情面板(DomainDetail)。
export async function runDns(domain) {
  domain = String(domain || '').toLowerCase().replace(/\.$/, '')
  if (!domain) return
  S.mode = 'dns'
  S.rows = []; S.selectedPid = null
  setSubjectDomain(domain)            // 设主体 + 桌面端自动开域名详情面板
  go('/dns/' + domain)
  S.dns = { domain, loading: true }
  S.msg = (S.lang === 'zh' ? `正在解析 ${domain} 的 DNS…` : `Resolving DNS for ${domain}…`)
  let res
  try { res = await resolveDns(domain) }
  catch (e) { S.dns = { domain, error: e.message }; S.msg = (S.lang === 'zh' ? `DNS 解析失败：${e.message}` : `DNS failed: ${e.message}`); return }
  // 仍在看同一域名才写回(用户可能已切走)。
  if (S.dns?.domain !== domain) return
  const recsOf = ty => (res.types.find(x => x.type === ty)?.records) || []
  const aRecs = recsOf('A'), aaaaRecs = recsOf('AAAA')
  const [a, aaaa] = await Promise.all([
    Promise.all(aRecs.map(rec => enrichIp(rec.data, false).then(e => ({ ...rec, ...e })))),
    Promise.all(aaaaRecs.map(rec => enrichIp(rec.data, true).then(e => ({ ...rec, ...e })))),
  ])
  if (S.dns?.domain !== domain) return
  const others = res.types.filter(t => t.type !== 'A' && t.type !== 'AAAA')
  S.dns = { domain, status: res.status, a, aaaa, others, errors: res.errors }
  const n = a.length + aaaa.length + others.reduce((s, t) => s + t.records.length, 0)
  S.msg = (S.lang === 'zh'
    ? (res.status === 3 ? `${domain}：域名不存在（NXDOMAIN）` : `${domain}：${n} 条 DNS 记录 · DNS over HTTPS`)
    : (res.status === 3 ? `${domain}: NXDOMAIN` : `${domain}: ${n} DNS records · DNS over HTTPS`))
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
export async function showInsight(pid, prefix) {
  S.detailKind = 'prefix'
  S.asnView = null
  S.selectedPid = pid
  go('/' + prefix)
  S.insight = { loading: true }
  const v6 = (prefix || '').includes(':')
  // 用 prefix 串的 [start,end] 裁剪 prefixes 文件(该 pid 的行 ip_start 落在此区间内, 只读相交文件)。
  const prng = v6 ? ip6Range(prefix) : ip2range(prefix)
  const src = rpList(prefixesFilesForRange(prng?.start, prng?.end, v6))
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
    loc: placeLabel(det.province, det.city, det.cc),
    origin_asn: det.origin_asn, origin_name: asnName(det.origin_asn), n_paths: det.n_paths,
    lowvis: isLowVis(det),
    paths: paths.map(p => ({ asns: Array.from(p.path_arr || []).map(Number), peers: p.n_peers, is_best: p.is_best })),
    sup, sub,
  }
}
// 父子段(更大/更小): v6 用 prefixes_v6 + ::UHUGEINT 字面量(范围在 SQL 里比, 不取回原始整数)。
async function relData(pid, s, e, v6) {
  const src = rpList(prefixesFilesForRange(s, e, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    const sup = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start <= ${lit(s)} AND ip_end >= ${lit(e)} AND pid <> ${pid} ORDER BY (ip_end-ip_start) ASC LIMIT 12`)
    const sub = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start >= ${lit(s)} AND ip_end <= ${lit(e)} AND pid <> ${pid} ORDER BY ip_start LIMIT 64`)
    return [sup, sub]
  } catch (e) { return [[], []] }
}
// ── ASN 详情视图(whois 由 Whois.svelte 自取; 这里只算本地 BGP: 通告前缀 + 观测上游) ──────
export async function showAsn(asn) {
  asn = +asn
  S.detailKind = 'asn'
  S.selectedPid = null
  S.insight = null
  S.asnView = { asn, name: asnName(asn), loading: true }
  go('/' + asn)
  if (!S.ready) { return }
  try {
    const psAll = pathsearchFilesForOrigin(asn)
    const psFiles = psAll === null ? [] : byFam(psAll)
    if (!psFiles.length) {   // 该 ASN 不是库内任何前缀的 origin(可能是纯 transit / 不在库)
      S.asnView = { asn, name: asnName(asn), count4: 0, count6: 0, prefixes: [], rel: emptyRel(), neigh: null }
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
      prefixes: rows, rel: deriveRelations(rows, asn), neigh: null,
    }
  } catch (e) { S.asnView = { asn, name: asnName(asn), error: e.message } }
}
// ── 邻居关系(三态: up=provider / peer / down=customer) ──────────────────────────────────
const emptyRel = () => ({ up: [], peer: [], down: [] })
// 在 acc(Map y -> {d,u,w,wd,evd,evu}) 中累计一条邻接观测。可靠证据 d/u, 假象 wd/w 仅供落 peer + 计数。
//   'd'  = Y 在 origin 侧, 且 X 左侧(收集器侧)存在 Tier-1 ⇒ X 经 DFZ 到达收集器, Y 是可靠客户;
//   'wd' = Y 在 origin 侧, 但 X 左侧无 Tier-1(X 是 full-feed 收集器边缘) ⇒ 方向不可靠(Y 可能是 X 的 provider/peer);
//   'u'  = Y 在收集器侧, 且其位置之上存在 Tier-1 ⇒ 可靠上游;
//   'w'  = Y 在收集器侧, 但其上无 Tier-1(full-feed/泄漏) ⇒ 上游假象。
// 各侧留一条样本路径作为「依据」(首次出现即记, 不覆盖)。
function bumpNeighbor(acc, y, side, prefix, arr) {
  let o = acc.get(y)
  if (!o) { o = { d: 0, u: 0, w: 0, wd: 0, evd: null, evu: null }; acc.set(y, o) }
  o[side]++
  if (side === 'd' || side === 'wd') { if (!o.evd) o.evd = { prefix, path: arr, side: 'd' } }
  else if (!o.evu) o.evu = { prefix, path: arr, side: 'u' }   // u/w 都属收集器侧
}
// 把累计的邻接 Map 按 classifyRelation 分到 up/peer/down 三组, 各带计数 + 一条依据路径。
// 关键: 方向分类只用可靠证据(d/u, 已剔除 full-feed 假象 wd/w); 不丢弃任何邻居 ——
//   只有绝对证据进上游/下游, 其余(含纯假象)一律落到 peer, 不臆测方向。
function groupRelations(asn, acc, limit) {
  const out = emptyRel()
  for (const [y, o] of acc) {
    const rel = classifyRelation(asn, y, o.d, o.u)         // wd/w 不传入, 不污染方向 ⇒ 仅假象者落 peer
    const ev = rel === 'down' ? (o.evd || o.evu) : (o.evu || o.evd)
    // 计数: 上下游用可靠证据; peer(含假象)用总观测次数, 以反映其被看到的频度。
    const n = rel === 'peer' ? (o.d + o.u + o.w + o.wd) : (o.d + o.u)
    out[rel].push({ asn: y, n, d: o.d, u: o.u, ev })
  }
  for (const k of ['up', 'peer', 'down']) out[k].sort((a, b) => b.n - a.n).splice(limit)
  return out
}
// 处理一条路径: 累计 asn 两侧邻接。上/下游证据都要求路径经过 DFZ 核心(Tier-1), 否则记为假象(w/wd)。
function accPath(acc, arr, asn, prefix) {
  let firstT1 = Infinity                          // 路径中第一个 Tier-1 的下标(从收集器侧起)
  for (let j = 0; j < arr.length; j++) { if (isTier1(arr[j])) { firstT1 = j; break } }
  for (let i = 0; i < arr.length; i++) if (arr[i] === asn) {
    if (i < arr.length - 1 && arr[i + 1] !== asn) {
      const weakDown = firstT1 >= i                // X 左侧(收集器侧)无 Tier-1 ⇒ X 未经 DFZ(full-feed 边缘),
      bumpNeighbor(acc, arr[i + 1], weakDown ? 'wd' : 'd', prefix, arr)  //   origin 侧邻居方向不可靠(可能是 provider)
    }
    if (i > 0 && arr[i - 1] !== asn) {
      const weakUp = firstT1 > i - 1               // 左邻位置之上无 Tier-1 ⇒ 未经 DFZ(full-feed/泄漏) ⇒ 上游假象
      bumpNeighbor(acc, arr[i - 1], weakUp ? 'w' : 'u', prefix, arr)
    }
  }
}
// 从通告前缀的 best_path 推邻居关系, 廉价、随通告前缀一起拿到(X=origin, 只会得到上游/对端)。
function deriveRelations(rows, asn) {
  const acc = new Map()
  for (const r of rows) accPath(acc, parseBest(r.best_path), asn, r.prefix)
  return groupRelations(asn, acc, 30)
}
// 按需「完整邻居」分析: 全表扫 pathsearch 里所有含该 ASN 的路径, 两侧邻接全收 → 三态分类。
// 重(大 transit ASN 命中分片多), 故不自动触发, 由面板按钮触发; LIMIT 兜底防超大。
export async function scanNeighbors(asn) {
  asn = +asn
  if (!S.asnView || S.asnView.asn !== asn) return
  S.asnView = { ...S.asnView, neigh: { loading: true } }
  try {
    const psAll = pathsearchFilesForOrigin(null)
    const psFiles = psAll === null ? [] : byFam(psAll)
    if (!psFiles.length) { S.asnView = { ...S.asnView, neigh: { ...emptyRel(), scanned: 0 } }; return }
    const rows = await q(`SELECT prefix, paths_blob FROM ${rpList(psFiles)} WHERE paths_blob LIKE '% ${asn} %' LIMIT 20000`)
    const acc = new Map()
    for (const r of rows) {
      for (const path of String(r.paths_blob || '').trim().split('|')) {
        accPath(acc, path.trim().split(/\s+/).map(Number), asn, r.prefix)
      }
    }
    S.asnView = { ...S.asnView, neigh: { ...groupRelations(asn, acc, 40), scanned: rows.length, capped: rows.length >= 20000 } }
  } catch (e) { S.asnView = { ...S.asnView, neigh: { error: e.message } } }
}

// ── 域名详情视图(WHOIS/RDAP 由 Whois.svelte kind='domain' 自取; 这里只置面板状态) ──
export function showDomain(domain) {
  domain = String(domain || '').toLowerCase().replace(/\.$/, '')
  S.detailKind = 'domain'
  S.selectedPid = null
  S.insight = null
  S.asnView = null
  S.domainView = { domain }
  go('/dns/' + domain)
}

// 精确框 ASN -> 设主体 + 自动开面板(主体变化时); 非 ASN -> 清主体。
// 移动端: 详情页全屏, 输入即自动弹出会打断输入 -> 只设主体不自动开, 由 Topbar 的「Whois」按钮显式打开。
const isMobileViewport = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches
function setSubjectAsn(asn) {
  if (asn == null) { S.subject = null; return }
  if (S.subject?.kind === 'asn' && S.subject.id === asn && S.detailKind) return  // 已在看, 别打断
  S.subject = { kind: 'asn', id: asn }
  if (!isMobileViewport()) showAsn(asn)
}
// 域名主体: 同 setSubjectAsn, 但开域名详情面板。
function setSubjectDomain(domain) {
  if (S.subject?.kind === 'domain' && S.subject.id === domain && S.detailKind === 'domain') return
  S.subject = { kind: 'domain', id: domain }
  if (!isMobileViewport()) showDomain(domain)
}
// Topbar「Whois」按钮(移动端): 显式打开当前精确框主体(ASN 或 域名)的详情面板。
export function openWhoisFromBox() {
  if (S.subject?.kind === 'asn') showAsn(S.subject.id)
  else if (S.subject?.kind === 'domain') showDomain(S.subject.id)
}

// ── 浏览器历史路由(PJAX) ──────────────────────────────────────────
// 单一真相 = 浏览器历史。开详情 pushState('/<asn|prefix>'); 面板 ←/→ = history.back()/forward();
// popstate 按 URL 重渲染。S.nav.{idx,max} 仅用于 ←/→ 的可用态。_suppressUrl 在按 URL 渲染时屏蔽回写。
let _suppressUrl = false
function go(path) {
  if (_suppressUrl || typeof history === 'undefined') return
  const cur = location.pathname + location.search
  if (cur === path) { history.replaceState({ idx: S.nav.idx }, '', path); return }   // 同 URL 不新增历史项
  const idx = S.nav.idx + 1
  history.pushState({ idx }, '', path)
  S.nav.idx = idx; S.nav.max = idx                                                    // 新前进 -> 截断更前的历史
}
export function navCanBack() { return S.nav.idx > 0 }
export function navCanFwd() { return S.nav.idx < S.nav.max }
export function navBack() { if (navCanBack()) history.back() }
export function navForward() { if (navCanFwd()) history.forward() }

function closeDetailState() { S.detailKind = null; S.selectedPid = null; S.insight = null; S.asnView = null; S.domainView = null }
// 智能关闭: 看子页(prefix/asn)且有主体上下文(ASN 或 域名) -> 先返回主体页; 否则真正关闭(再点即关)。
export function closeInsight() {
  if (S.detailKind === 'prefix' && S.subject?.kind === 'asn') { showAsn(S.subject.id); return }
  if (S.detailKind !== 'domain' && S.subject?.kind === 'domain') { showDomain(S.subject.id); return }
  hardCloseDetail()
}
// 彻底关闭(Esc / 移动端关闭): 关详情 + URL 回到搜索态。DNS 模式下保留 /dns/<域名>(左侧记录仍在);
// 否则框非空 -> /?q=, 否则根。
export function hardCloseDetail() {
  closeDetailState()
  if (S.mode === 'dns' && S.dns?.domain) { go('/dns/' + S.dns.domain); return }
  const box = (S.filters.ip || '').trim()
  go(box ? `/?q=${encodeURIComponent(box)}` : '/')
}

// 按前缀串精确开 prefix 详情(URL/popstate 用, 因 URL 只有前缀串无 pid)。命中库内同范围前缀则展开。
async function openPrefixByString(s) {
  const v6 = s.includes(':')
  const r = v6 ? ip6Range(s) : ip2range(s)
  if (!r) return
  const src = rpList(prefixesFilesForRange(r.start, r.end, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    const rows = await q(`SELECT pid, prefix FROM ${src} WHERE ip_start=${lit(r.start)} AND ip_end=${lit(r.end)} ORDER BY n_paths DESC LIMIT 1`)
    if (rows[0]) showInsight(rows[0].pid, rows[0].prefix)
  } catch (e) { /* 无精确匹配则仅显示子网搜索结果 */ }
}

// 解析 URL(路径 /<asn|prefix> 或 ?q=<词>)并渲染。initial=首次加载(种 history.state.idx); 否则 popstate。
export async function applyRoute({ initial = false } = {}) {
  _suppressUrl = true
  try {
    if (initial && history.state?.idx == null) history.replaceState({ idx: 0 }, '', location.pathname + location.search)
    S.nav.idx = history.state?.idx ?? 0
    if (initial) S.nav.max = S.nav.idx
    const sp = new URLSearchParams(location.search)
    const q0 = sp.get('q')
    const path = decodeURIComponent(location.pathname).replace(/^\/+/, '').replace(/\/+$/, '')
    if (path.startsWith('dns/')) {                 // /dns/<域名> -> DNS 解析视图
      const domain = path.slice(4)
      S.filters.ip = domain
      await runDns(domain)
    } else if (path) {
      const probe = classifyQuery(path)
      S.filters.ip = path
      await runSearch()
      if (probe.kind === 'asn') showAsn(probe.asn)
      else if (probe.kind === 'ipv4' || probe.kind === 'ipv6') await openPrefixByString(path)
    } else if (q0 != null) {
      S.filters.ip = q0
      await runSearch()
    } else {
      closeDetailState()
      await runSearch()
    }
  } finally { _suppressUrl = false }
}
