// WHOIS 兜底解析: 标签 -> 规范 key 字典 + 多格式纯文本解析器。
//
// 服务于「无 RDAP 的 ccTLD」: 前端 RDAP 全失败时走 whois-worker 取回 port-43 原文(见 rdap.js),
// 这里把各注册局五花八门的列名映射到与 RDAP 统一的规范 key(图标见 whois-fields.js, 文案见 i18n w_*)。
//
// 列名来源(实测 + 两个开源 whois 解析器的逐 TLD 正则字面量):
//   · richardpenman/whois (whois/parser.py)、mboot-github/WhoisDomain (tld_regexpr.py)
//   · 各注册局 whois 实测: JPRS(.jp)、KISA(.kr)、DENIC(.de)、TCI(.ru/.su)、nic.it、SWITCH(.ch/.li)、
//     EURid(.eu)、DNS.be、nic.at、DK Hostmaster(.dk)、IIS(.se/.nu)、IEDR(.ie)、CNNIC(.cn)、HKIRC(.hk)、
//     InternetNZ(.nz)、ISOC-IL(.il)、TRABIS(.tr) 等。
//
// 四种行格式都吃:
//   1) inline   "Label: value"            —— 多数 gTLD/ccTLD
//   2) jprs     "x. [Label]   value"      —— .jp(可选 a./g./p./s. 前缀; 日/英双标签)
//   3) rpsl     "key: value"(键可重复)   —— .de/.ru/.at/.se/.ie/.il(RIPE 派生)
//   4) indented "Label:" 换行后缩进值     —— Nominet .uk / .dk / .eu / .be / .it / .ch(段头 + 缩进值)
// 始终保留全文(rawWhois)由 <pre> 展示, 解析行只是「友好摘要」, 不丢信息。

// ── 规范 key -> 该字段在各注册局出现过的列名(全部小写, 已去重) ──
const FIELD_LABELS = {
  ldhname: ['domain', 'domain name', 'domainname', 'domain_name', 'nom de domaine', 'nombre de dominio', 'ドメイン名'],
  org: ['org', 'organization', 'organisation', 'organization name', 'org-name', 'holder', 'holder of domain name',
    'owner', 'owner name', 'owner contact', 'registrant', 'registrant name', 'registrant org', 'registrant organization',
    'registrant organisation', 'registrant contact', 'registrant contact name', 'descr', 'titular', 'company english name',
    'organization using domain name', 'domain holder organization', '組織名', 'そしきめい'],
  registrar: ['registrar', 'registrar name', 'registrar-name', 'registrar handle', 'sponsoring registrar',
    'sponsoring registrar organization', 'authorized agency', 'registration service provider', 'record maintained by',
    'registered by'],
  registration: ['created', 'created on', 'created date', 'creation date', 'creationdate', 'registered', 'registered on',
    'registered date', 'registration date', 'registration time', 'record created', 'record created on', 'domain created',
    'domain registered', 'domain registration date', 'domain record activated', 'domain name commencement date',
    'first registration date', 'domain_dateregistered', 'date de création', '登録年月日'],
  lastchanged: ['changed', 'modified', 'modified date', 'modification date', 'updated', 'updated date', 'updated on',
    'updateddate', 'last update', 'last-update', 'last updated', 'last-updated', 'last updated on', 'last updated date',
    'last modified', 'record last updated on', 'domain record last updated', 'domain last updated date', 'entry updated',
    'domain_datelastmodified', 'dernière modification', '最終更新'],
  expiration: ['expire', 'expires', 'expires on', 'expire date', 'expire-date', 'expiry', 'expiry date', 'exp date',
    'expiration', 'expiration date', 'expiration time', 'registry expiry date', 'registrar registration expiration date',
    'record expires on', 'record will expire on', 'domain expires', 'domain expiration date', 'paid-till', 'valid until',
    'validity', 'renewal', 'renewal date', 'domain_datebilleduntil', "date d'expiration"],
  status: ['status', 'state', 'domain status', 'registration status', 'registry status', 'transfer status',
    'query_status', 'statut', '状態'],
  ns: ['nserver', 'nameserver', 'nameservers', 'name server', 'name servers', 'name servers information',
    'name server information', 'name servers in the listed order', 'domain servers in listed order', 'domain name servers',
    'domain nameservers', 'dns servers', 'host name', 'hostname', 'serveur de noms', 'ネームサーバ'],
  dnssec: ['dnssec', 'signed', 'signed delegation', 'domain_signed', 'nsec', 'signing key', '署名鍵'],
  country: ['country', 'registrant country', 'registrant-country', 'org-country', 'domain holder country',
    'registrant country/economy', 'país'],
  email: ['e-mail', 'email', 'holder email', 'registrant contact email'],
}

const LABEL2KEY = new Map()
for (const [k, labels] of Object.entries(FIELD_LABELS)) for (const l of labels) LABEL2KEY.set(l, k)

// indented-block 的「裸段头」(无冒号也要识别成名称服务器段, 如 nic.it 的 "Nameservers")
const NS_HEADERS = new Set(['name servers', 'nameservers', 'name server', 'domain servers', 'name servers information',
  'name servers in the listed order', 'domain servers in listed order', 'domain name servers', 'domain nameservers'])

// 归一化标签: 去前导 * / > 与空白、去尾随点(.tr/.kz 点引导 "Created on......:")与全角空格, 小写。
function cleanLabel(s) {
  return s.replace(/^[\s*>]+/, '').replace(/[\s.　]+$/, '').trim().toLowerCase()
}

// 标签 -> 规范 key(null=不认识, 仅留原文)。
export function whoisKey(label) {
  const k = LABEL2KEY.get(label)
  if (k) return k
  if (label.startsWith('registrar abuse contact email')) return 'email'
  if (label.startsWith('registrant ') && label.endsWith(' organization')) return 'org'
  if (/^ns_name_\d+$/.test(label)) return 'ns'        // InternetNZ: ns_name_01 / ns_name_02 …
  return null
}

// 归一化日期到 YYYY-MM-DD。容忍: ISO/RDAP 2026-04-01T… · JP 2026/04/01 (JST) · KR 2002. 06. 28. · 2011.01.18
export function fmtDate(s) {
  if (!s) return ''
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (!m) m = /(\d{4})[.\/]\s*(\d{1,2})[.\/]\s*(\d{1,2})/.exec(s)
  if (!m) return String(s).trim()
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
}

// 扁平 whois 文本 -> 规范化模型(与 rdap.normalize 同形)。
export function parseWhois(domain, server, text) {
  const head = [{ key: 'ldhname', value: domain }]
  const seen = new Set()
  const push = (ck, v) => {
    if (!ck || ck === 'ldhname') return
    if (ck === 'registration' || ck === 'lastchanged' || ck === 'expiration') v = fmtDate(v)
    v = (v == null ? '' : String(v)).trim()
    if (!v || /^(redacted|not disclosed|gdpr|please visit|see )/i.test(v)) return   // 脱敏占位不入摘要
    const sig = ck + ' ' + v
    if (seen.has(sig)) return
    seen.add(sig)
    head.push({ key: ck, value: v })
  }
  let pending = null   // indented-block: 上一行是「空值标签」时记住其规范 key, 下面缩进值归到它
  for (const raw of String(text).split(/\r?\n/)) {
    const indented = /^[ \t　]/.test(raw)
    const line = raw.trim()
    if (!line) { pending = null; continue }
    if (line[0] === '%' || line[0] === '#') { pending = null; continue }   // 注释/横幅
    // 2) JPRS 括号: 可选 "x. " + "[Label]"(label 首字符非空格, 借此排除 "[ 横幅文字 ]") + 空白 + 值
    const mb = /^(?:[a-z]\.\s*)?\[(\S[^\]]*?)\]\s+(.+)$/i.exec(line)
    if (mb) { push(whoisKey(cleanLabel(mb[1])), mb[2]); pending = null; continue }
    // 1)/3) 冒号分隔
    const i = line.indexOf(':')
    if (i >= 0) {
      const label = cleanLabel(line.slice(0, i))
      const value = line.slice(i + 1).trim()
      const ck = whoisKey(label)
      if (value) { push(ck, value); pending = ck === 'ns' ? 'ns' : null }   // 同行有值; ns 续行可能紧跟
      else pending = ck || (NS_HEADERS.has(label) ? 'ns' : null)            // 4) 空值标签 -> 等下面缩进值
      continue
    }
    // 4) 无冒号: 缩进续值归到 pending; 裸 ns 段头(如 nic.it "Nameservers")也起一个 ns 段
    if (indented && pending) { push(pending, line); if (pending !== 'ns') pending = null; continue }
    if (NS_HEADERS.has(cleanLabel(line))) { pending = 'ns'; continue }
    pending = null
  }
  return { kind: 'domain', key: domain, title: domain, head, entities: [], remarks: [], rawWhois: String(text).trim(), source: server, via: 'whois' }
}
