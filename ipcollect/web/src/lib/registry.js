// dn42 静态 registry whois 读取(取代在线 RDAP)。导出期已把每个 ASN 的 whois 构造成与
// rdap.normalize() 同形的模型(head 行 + admin/tech/mnt 实体树), 这里只 fetch + 内存缓存。
// 当 site.features.rdapWhois === false(dn42)时, Whois.svelte 改调本模块。
import { getData, dv } from './db.js'

const _cache = new Map()

function _placeholder(msg) {
  return { head: [], entities: [], remarks: [{ value: msg }], source: 'DN42 Registry', via: 'registry' }
}

// 从完整域名逐级去掉最左标签, 找到 registry 里登记的那层 zone(子域名回退到上级)。
async function _fetchDomain(name) {
  let labels = name.split('.').filter(Boolean)
  while (labels.length >= 1) {
    try {
      const m = await getData(`/registry/domain/${labels.join('.')}.json${dv()}`)
      if (m && m.head) return m
    } catch { /* 该层无登记, 试上一级 */ }
    labels = labels.slice(1)
  }
  return _placeholder(`${name}: registry 无此域名`)
}

// kind: 'autnum' -> data/registry/autnum/AS<n>.json; 'domain' -> data/registry/domain/<zone>.json; 'ip' -> 暂无(占位)。
export async function fetchRegistry(kind, key) {
  const ck = `${kind}:${key}`
  if (_cache.has(ck)) return _cache.get(ck)
  let model
  if (kind === 'autnum') {
    const asn = String(key).replace(/^AS/i, '')
    try { model = await getData(`/registry/autnum/AS${asn}.json${dv()}`) }
    catch { model = null }
    if (!model || !model.head) model = _placeholder(`AS${asn}: registry 无此对象`)
  } else if (kind === 'domain') {
    model = await _fetchDomain(String(key).toLowerCase().replace(/\.$/, ''))
  } else {
    model = _placeholder('dn42 registry whois 暂仅支持 ASN / 域名')
  }
  _cache.set(ck, model)
  return model
}
