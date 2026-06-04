// dn42 站专属 i18n 覆盖（独立字符串文件）。i18n.js 在 SITE==='dn42' 时把这里的键覆盖到 STRINGS。
// 只列与公网站(peeras)不同的文案；未列出的键沿用 i18n.js 的基础字符串。
export const OVERRIDES = {
  zh: {
    page_title: 'DN42.PEER.AS — dn42 BGP / ASN / registry 洞察',
    page_desc: 'DN42.PEER.AS — 探索 dn42 网络：前缀、ASN、AS_PATH、origin 与对端，registry whois 与按 person 浏览。纯静态可复现。',
    // AS_PATH 框：去掉示例与「回车搜索」提示
    ph_path: 'AS_PATH',
    // 主搜索框：dn42 示例 + 支持域名(registry whois)
    ph_ip: 'IP / CIDR / ASN / 域名，如 172.20.0.0/24、AS4242420000、foo.dn42',
    // 落地提示：person 取代国家/地区
    pick_country: '选一个 <b>person</b> 浏览其前缀；或输入 <b>AS_PATH</b> / <b>origin AS</b> 做<b>全表搜索</b>；或按 <b>IP</b> 子网、<b>域名</b> 查 whois。',
    // whois 来源是 registry（不是 RDAP）
    whois_title: 'WHOIS / 注册信息（registry）', whois_src: '来源',
    whois_open: '查看该 ASN 的 registry 信息',
    t_country: 'person',
    // dn42 无密码学 RPKI：ROA 由 registry route/route6 对象的 max-length 派生（与 IRR 同源），故标 ROA 而非 RPKI。
    rpki_badge: 'ROA',
    rpki_valid: 'ROA 有效（registry route 对象的 max-length 授权该 origin 通告此前缀）',
    rpki_inv_asn: 'ROA 无效：origin AS 未被任何 registry route 对象授权通告此前缀',
    rpki_inv_len: 'ROA 无效：前缀比 registry route 对象的 max-length 更具体',
    rpki_notfound: 'ROA 未找到：此前缀无覆盖的 registry route 对象（max-length 授权）',
  },
  en: {
    page_title: 'DN42.PEER.AS — dn42 BGP, ASN & registry insights',
    page_desc: 'DN42.PEER.AS — explore the dn42 network: prefixes, ASNs, AS_PATH, origins & peering, registry whois and browse-by-person. Static & reproducible.',
    ph_path: 'AS_PATH',
    ph_ip: 'IP / CIDR / ASN / domain, e.g. 172.20.0.0/24, AS4242420000, foo.dn42',
    pick_country: 'Pick a <b>person</b> to browse their prefixes, or type an <b>AS_PATH</b> / <b>origin AS</b> for a <b>global search</b>, or look up a <b>subnet</b> / <b>domain</b> whois.',
    whois_title: 'WHOIS / registration (registry)', whois_src: 'source',
    whois_open: 'Open registry info for this ASN',
    t_country: 'person',
    // dn42 has no cryptographic RPKI: ROA is derived from registry route/route6 max-length (same source as IRR), so label it ROA, not RPKI.
    rpki_badge: 'ROA',
    rpki_valid: 'ROA Valid — a registry route object’s max-length authorizes this origin for this prefix',
    rpki_inv_asn: 'ROA Invalid — origin AS not authorized by any registry route object for this prefix',
    rpki_inv_len: 'ROA Invalid — prefix is more specific than the registry route object’s max-length',
    rpki_notfound: 'ROA Not Found — no registry route object (max-length authorization) covers this prefix',
  },
}
