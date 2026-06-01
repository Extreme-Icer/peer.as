// AS_PATH / ASN / geo 纯逻辑 (从 web_ref/app.js 移植)。读 S.meta / S.lang 故有响应性。
import { S } from './store.svelte.js'

const OP_CLS = { '电信': 'op-ct', '联通': 'op-cu', '移动': 'op-cm', '教育': 'op-edu', '科技': 'op-sci', '国际': 'op-intl' }
export const TIER1 = new Set([174, 701, 702, 1239, 1299, 2828, 2914, 3257, 3320, 3356, 3491,
  5511, 6453, 6461, 6762, 6830, 6939, 7018, 7473, 12956, 1273, 3549, 3551, 209])

// 全量名(asnames.json)优先, 回退到 meta 里精选的(注册表)
export const asnName = a => (S.asnNames && S.asnNames[a]) || (S.meta && S.meta.asn_names && S.meta.asn_names[a]) || ''
export const opOf = a => (S.meta && S.meta.asn_ops && S.meta.asn_ops[a]) || ''
export const opCls = a => OP_CLS[opOf(a)] || ''
export const isTier1 = a => TIER1.has(+a)

// 国家/地区名覆盖(必须先于 Intl.DisplayNames): CN/TW/HK/MO 的规范表述。
const CC_OVERRIDE = {
  zh: { CN: '中国大陆', TW: '中国台湾', MO: '中国澳门', HK: '中国香港' },
  en: { CN: 'Chinese Mainland', TW: 'Taiwan, China', MO: 'Macao', HK: 'Hong Kong' },
}
let _region = {}
export function regionName(cc) {
  const lang = S.lang === 'zh' ? 'zh' : 'en'
  if (CC_OVERRIDE[lang][cc]) return CC_OVERRIDE[lang][cc]
  try {
    _region[lang] = _region[lang] || new Intl.DisplayNames([lang], { type: 'region' })
    const n = _region[lang].of(cc); if (n && n !== cc) return n
  } catch (e) { /* ignore */ }
  const m = lang === 'zh' ? (S.meta && S.meta.country_names) : (S.meta && S.meta.country_names_en)
  return (m && m[cc]) || cc
}
export const ccLabel = cc => `${regionName(cc)} (${cc})`

export const lowCut = () => Math.max(3, 0.2 * ((S.meta && S.meta.dfz_ref) || 1))
export const isLowVis = r => !!r && r.n_paths != null && S.meta && S.meta.dfz_ref && r.n_paths < lowCut()

const short = s => (s && s.length > 22) ? s.slice(0, 21) + '…' : s
// AS_PATH -> [{asn,name,nameShort,op,cls,tier1}]  (供 <AsPath> 渲染; nameShort 防超长 handle 撑爆路径)
export function pathTokens(asns) {
  return (asns || []).map(a => {
    const name = asnName(a)
    return { asn: a, name, nameShort: short(name), op: opOf(a), cls: opCls(a), tier1: TIER1.has(+a) }
  })
}
export const parseBest = s => (s ? s.trim().split(/\s+/).map(Number) : [])

export const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'"

export function ip2int(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((s || '').trim())
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) { const o = +m[i]; if (o > 255) return null; n = n * 256 + o }
  return n >>> 0
}
export const int2ip = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

// IPv4 地址或 CIDR -> {start,end,plen,isCidr}; 纯 IP 视作单点(/32)。非法返回 null。
export function ip2range(s) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/.exec((s || '').trim())
  if (!m) return null
  const base = ip2int(m[1])
  if (base === null) return null
  if (m[2] === undefined) return { start: base, end: base, plen: 32, isCidr: false }
  const plen = +m[2]
  if (plen > 32) return null
  const size = Math.pow(2, 32 - plen)        // plen=0 -> 2^32, 仍在安全整数内
  const start = base - (base % size)          // 对齐到网络地址
  return { start, end: start + size - 1, plen, isCidr: true }
}

// 把精确框文本归类成查询类型并路由: asn / ipv4 / ipv6 / text / empty
export function classifyQuery(s) {
  s = (s || '').trim()
  if (!s) return { kind: 'empty' }
  if (s.includes(':')) return { kind: 'ipv6' }                  // 冒号 -> IPv6 (暂未支持)
  if (s.includes('.') || s.includes('/')) {                     // 点分十进制 / 带掩码 -> IPv4
    const r = ip2range(s)
    return r ? { kind: 'ipv4', ...r } : { kind: 'text' }
  }
  const asm = /^(?:asn?\s*)?([0-4]?\d{1,9})$/i.exec(s)  // 纯数字 或 AS/ASN 前缀(大小写均可) -> ASN
  if (asm) return { kind: 'asn', asn: parseInt(asm[1], 10) }
  return { kind: 'name', q: s }   // 其余(含字母, 无点/冒号/斜杠) -> 按 AS 名称搜索, 反推 origin ASN
}

// AS 名称 -> origin ASN 反查。索引(asn -> 小写名)由全量 asnames.json + 注册表(meta.asn_names, 含中文运营商名)
// 合并而成, 同一 ASN 的多个名都收录(故中/英名都能命中); 按 meta/asnNames 条目数做轻量缓存键, 变了才重建。
let _nidx = null, _nidxKey = ''
function nameIndex() {
  const full = S.asnNames || {}, reg = (S.meta && S.meta.asn_names) || {}
  const key = Object.keys(full).length + ':' + Object.keys(reg).length
  if (_nidx && _nidxKey === key) return _nidx
  const arr = []
  const add = (k, name) => { if (!name) return; const a = +k; if (a) arr.push({ asn: a, nl: String(name).toLowerCase() }) }
  for (const k in reg) add(k, reg[k])
  for (const k in full) add(k, full[k])
  _nidx = arr; _nidxKey = key; return arr
}
// 返回 { asns:[origin...], more } : 子串(忽略大小写)命中, 按 精确=0 / 词首=1 / 子串=2 排序, 同 ASN 去重, 截断到 cap。
export function asnsMatchingName(query, cap = 200) {
  const ql = (query || '').trim().toLowerCase()
  if (!ql) return { asns: [], more: false }
  const best = new Map()
  for (const { asn, nl } of nameIndex()) {
    const i = nl.indexOf(ql); if (i < 0) continue
    const rank = nl === ql ? 0 : (i === 0 || /\W/.test(nl[i - 1]) ? 1 : 2)
    const prev = best.get(asn); if (prev == null || rank < prev) best.set(asn, rank)
  }
  const hits = [...best.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  return { asns: hits.slice(0, cap).map(h => h[0]), more: hits.length > cap }
}

export function parseSeq(str) {
  return (str || '').trim().replace(/->/g, ' ').replace(/,/g, ' ')
    .split(/\s+/).filter(x => /^\d+$/.test(x)).map(Number)
}
export function seqIn(asns, seq) {
  if (!seq.length) return true
  const n = asns.length, m = seq.length
  for (let i = 0; i + m <= n; i++) {
    let ok = true
    for (let j = 0; j < m; j++) if (asns[i + j] !== seq[j]) { ok = false; break }
    if (ok) return true
  }
  return false
}

// ── AS_PATH 高级查询: 通配 + 排除 ──────────────────────────────────────────────
// 语法: 数字=ASN; `*`=任意间隔(含 0 跳, 同一条路径内); `?`=正好一跳; `!N`/`-N`=排除该 ASN(整条路径都不含)。
//   1299 4538      相邻
//   1299 * 4538    1299 在 4538 之前(任意间隔, 同一路径)
//   1299 ? 4538    中间正好 1 跳
//   4538 !174      含 4538、且全程不经 174
// paths_blob 形如 ' a b c | d e f ': 用 `[0-9]` 字符类(不含 `|`)保证序列匹配锁在同一条路径内,
// 不会出现「A 在路径1、B 在路径2」的假命中。
function _normWild(include) {     // 去首尾通配 + 合并连续通配(任一 * 则为 *, 否则 ? 计数累加)
  const a = include.slice()
  while (a.length && (a[0] === '*' || a[0] === '?')) a.shift()
  while (a.length && (a[a.length - 1] === '*' || a[a.length - 1] === '?')) a.pop()
  const out = []
  for (const tok of a) {
    const prev = out[out.length - 1]
    if ((tok === '*' || tok === '?') && prev && (prev === '*' || typeof prev === 'object')) {
      if (tok === '*' || prev === '*') out[out.length - 1] = '*'
      else prev.q++           // 连续 ? 累加成 {q:n}
    } else if (tok === '?') out.push({ q: 1 })
    else out.push(tok)        // 数字 或 '*'
  }
  return out
}
// 把归一化 include 编译成锚定空格的正则源(对 blob 与单路径串都适用)
function _reSource(norm) {
  let re = ' '
  for (const tok of norm) {
    if (tok === '*') re += '(?:[0-9]+ )*'
    else if (typeof tok === 'object') re += '(?:[0-9]+ ){' + tok.q + '}'   // 正好 q 跳
    else re += tok + ' '
  }
  return re
}
export function parsePathQuery(str) {
  const raw = (str || '').trim().replace(/->/g, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  const include0 = [], excludes = []
  for (const tok of raw) {
    if (/^\*+$/.test(tok)) { include0.push('*'); continue }       // 一个或多个 * 都视作任意间隔
    if (/^\?+$/.test(tok)) { for (let i = 0; i < tok.length; i++) include0.push('?'); continue }  // ?? = 两跳
    const ex = /^[!-](\d+)$/.exec(tok); if (ex) { excludes.push(+ex[1]); continue }
    const m = /^(\d+)$/.exec(tok); if (m) include0.push(+m[1])
  }
  const norm = _normWild(include0)
  const nums = norm.filter(x => typeof x === 'number')
  const wildcard = norm.some(x => x === '*' || typeof x === 'object')
  return { include: norm, nums, excludes, wildcard, hasInclude: norm.length > 0, reSource: norm.length ? _reSource(norm) : null }
}
// 编译查询: 提供 SQL 条件、best-path 排序表达式、单路径 JS 匹配、状态栏摘要。
export function compilePathQuery(str) {
  const q = parsePathQuery(str)
  const empty = !q.hasInclude && !q.excludes.length
  const re = q.reSource ? new RegExp(q.reSource) : null
  return {
    ...q, empty,
    // WHERE 条件数组(作用于给定列, 通常 'paths_blob')
    sqlConds(col) {
      const c = []
      if (q.hasInclude) c.push(q.wildcard
        ? `regexp_matches(${col}, ${sqlStr(q.reSource)})`
        : `${col} LIKE ${sqlStr('% ' + q.nums.join(' ') + ' %')}`)
      for (const x of q.excludes) c.push(`${col} NOT LIKE ${sqlStr('% ' + x + ' %')}`)
      return c
    },
    // best_path 命中 include -> 置顶★(排序用); 无 include 返回 null
    sqlBest(bestCol) {
      if (!q.hasInclude) return null
      return q.wildcard
        ? `regexp_matches(${bestCol}, ${sqlStr(q.reSource)})`
        : `${bestCol} LIKE ${sqlStr('% ' + q.nums.join(' ') + ' %')}`
    },
    // 单条路径(asn 数组)是否命中 include 序列 — 抽屉里高亮用
    test(asns) { return re ? re.test(' ' + (asns || []).join(' ') + ' ') : true },
    // 路径字符串(best_path, 已带首尾空格)是否命中 include
    testStr(s) { return re && s ? re.test(s) : false },
    // 状态栏可读摘要
    summary() {
      const parts = []
      if (q.hasInclude) parts.push(q.include.map(t => t === '*' ? '*' : typeof t === 'object' ? '?'.repeat(t.q) : t).join(' '))
      for (const x of q.excludes) parts.push('!' + x)
      return parts.join(' ')
    },
  }
}
export function truncToTier1(asns) {
  // 从最上游(数组头)往下找**第一个** Tier-1, 保留它到 origin 的整段 ⇒ 图的末端(最上游列)恒为 Tier-1,
  // 且经多个 Tier-1 转接的链完整保留(如 1299→174→origin、3549→3356→174→origin);
  // origin 之上、最上游 Tier-1 之前的非 Tier-1(IXP/小上游)被裁掉, 以保证「末端为 Tier-1」。
  for (let i = 0; i < asns.length; i++) if (TIER1.has(asns[i])) return asns.slice(i)
  return asns.length > 1 ? asns.slice(1) : asns
}

// 区间 [{s,e}] -> 最简 CIDR (不用位运算防 32 位溢出; BigInt 转 Number)
export function rangesToCidrs(segs) {
  const out = []
  const merged = Array.from(segs || []).map(o => [Number(o.s), Number(o.e)]).sort((a, b) => a[0] - b[0])
  for (let [s, e] of merged) {
    while (s <= e) {
      let size = 1, plen = 32
      while (plen > 0) {
        const ns = s - (s % (size * 2))
        if (ns !== s || s + size * 2 - 1 > e) break
        size *= 2; plen--
      }
      out.push(`${int2ip(s)}/${plen}`)
      s += size
    }
  }
  return out
}
