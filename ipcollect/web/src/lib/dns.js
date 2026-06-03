// DNS over HTTPS 客户端(纯前端直连, 零后端)。
// - 走 Cloudflare DoH JSON 格式: GET https://cloudflare-dns.com/dns-query?name=&type= + Accept: application/dns-json
//   (Accept 是 CORS 安全列表头, 简单 GET 无预检; 端点回 Access-Control-Allow-Origin:* —— 浏览器可直连)。
// - 一次解析并发查多种记录类型(A/AAAA/CNAME/NS/MX/TXT/SOA/CAA), 各自独立, 单类型失败不影响其它。
// - 返回 { domain, status, types:[{type, records:[{name,ttl,data}]}] }; A/AAAA 的前缀/ASN 富集在 queries.js 做。
// - 缓存: 内存(去重 in-flight) + sessionStorage(跨刷新), key = `dns:<domain>`。
const ENDPOINT = 'https://cloudflare-dns.com/dns-query'

// 查询的记录类型(name 用于 query 参数, code 用于过滤 Answer —— Answer 里可能混入 CNAME 等其它类型)。
const TYPES = [
  { name: 'A', code: 1 },
  { name: 'AAAA', code: 28 },
  { name: 'CNAME', code: 5 },
  { name: 'NS', code: 2 },
  { name: 'MX', code: 15 },
  { name: 'TXT', code: 16 },
  { name: 'SOA', code: 6 },
  { name: 'CAA', code: 257 },
]

async function query(domain, type) {
  const url = `${ENDPOINT}?name=${encodeURIComponent(domain)}&type=${type}`
  const r = await fetch(url, { headers: { Accept: 'application/dns-json' } })
  if (!r.ok) throw new Error(`DoH ${type} → HTTP ${r.status}`)
  return r.json()
}

async function doResolve(domain) {
  const ssKey = `dns:${domain}`
  try { const c = sessionStorage.getItem(ssKey); if (c) return JSON.parse(c) } catch { /* 隐私模式忽略 */ }

  // 并发查全部类型; 单个失败 -> 该类型为空, 不阻断整体。
  const settled = await Promise.all(TYPES.map(async t => {
    try { return { t, d: await query(domain, t.name) } }
    catch (e) { return { t, d: null, err: e.message } }
  }))

  const out = { domain, status: null, types: [], errors: [] }
  for (const { t, d, err } of settled) {
    if (!d) { out.errors.push(`${t.name}: ${err}`); continue }
    if (out.status == null) out.status = d.Status            // 0=NOERROR, 3=NXDOMAIN
    const recs = (d.Answer || [])
      .filter(a => a.type === t.code)
      .map(a => ({ name: a.name, ttl: a.TTL, data: stripQuotes(a.data, t.name) }))
    if (recs.length) out.types.push({ type: t.name, records: recs })
  }
  // 全类型都没拿到响应(网络/被墙) -> 抛错, 让 UI 显示失败而非空。
  if (out.status == null) throw new Error(out.errors[0] || 'DNS 解析失败')
  try { sessionStorage.setItem(ssKey, JSON.stringify(out)) } catch { /* 配额忽略 */ }
  return out
}

// TXT 记录值常被 DoH 用双引号包裹(长串还会拆成多段拼接), 去掉首尾引号便于阅读。
function stripQuotes(data, type) {
  if (type !== 'TXT') return data
  return String(data || '').replace(/"\s+"/g, '').replace(/^"|"$/g, '')
}

const mem = new Map()   // domain -> Promise<result>(并发去重)
export function resolveDns(domain) {
  const key = String(domain || '').toLowerCase().replace(/\.$/, '')
  if (mem.has(key)) return mem.get(key)
  const p = doResolve(key).catch(e => { mem.delete(key); throw e })
  mem.set(key, p)
  return p
}
