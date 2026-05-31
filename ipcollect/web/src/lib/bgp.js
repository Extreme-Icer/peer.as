// AS_PATH / ASN / geo 纯逻辑 (从 web_ref/app.js 移植)。读 S.meta / S.lang 故有响应性。
import { S } from './store.svelte.js'

const OP_CLS = { '电信': 'op-ct', '联通': 'op-cu', '移动': 'op-cm', '教育': 'op-edu', '科技': 'op-sci', '国际': 'op-intl' }
export const TIER1 = new Set([174, 701, 702, 1239, 1299, 2828, 2914, 3257, 3320, 3356, 3491,
  5511, 6453, 6461, 6762, 6830, 7018, 7473, 12956, 1273, 3549, 3551, 209])

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
export function truncToTier1(asns) {
  for (let i = asns.length - 1; i >= 0; i--) if (TIER1.has(asns[i])) return asns.slice(i)
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
