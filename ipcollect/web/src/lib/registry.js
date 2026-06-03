// dn42 静态 registry whois 读取(取代在线 RDAP)。导出期已把每个 ASN 的 whois 构造成与
// rdap.normalize() 同形的模型(head 行 + admin/tech/mnt 实体树), 这里只 fetch + 内存缓存。
// 当 site.features.rdapWhois === false(dn42)时, Whois.svelte 改调本模块。
import { getData, dv } from './db.js'

const _cache = new Map()

function _placeholder(msg) {
  return { head: [], entities: [], remarks: [{ value: msg }], source: 'DN42 Registry', via: 'registry' }
}

// kind: 'autnum' -> 取 data/registry/autnum/AS<n>.json; 'ip'/'domain' -> dn42 v1 暂无(优雅占位, 不报错)。
export async function fetchRegistry(kind, key) {
  const ck = `${kind}:${key}`
  if (_cache.has(ck)) return _cache.get(ck)
  let model
  if (kind === 'autnum') {
    const asn = String(key).replace(/^AS/i, '')
    try { model = await getData(`/registry/autnum/AS${asn}.json${dv()}`) }
    catch { model = null }
    if (!model || !model.head) model = _placeholder(`AS${asn}: registry 无此对象`)
  } else {
    model = _placeholder('dn42 registry whois 暂仅支持 ASN')
  }
  _cache.set(ck, model)
  return model
}
