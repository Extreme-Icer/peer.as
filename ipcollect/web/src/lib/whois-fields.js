// WHOIS/RDAP 规范 key -> Font Awesome 图标。未知 key 用默认点(iDot), 保证「不认识的也有图标」。
import {
  iHandle, iTag, iBuilding, iFlag, iShield, iMail, iAt, iPhone, iFax, iLoc, iReg,
  iStatus, iRange, iParent, iRole, iTitle, iLink, iNote, iDot, iPrefix, iNet, iChangelog,
  iUsers, iUser,
} from './icons.js'

const KEY_ICON = {
  handle: iHandle, name: iTag, fullname: iTag, asrange: iRange, iprange: iRange, cidr: iNet,
  iptype: iPrefix, parent: iParent, country: iFlag, status: iStatus,
  registration: iReg, lastchanged: iChangelog, expiration: iReg,
  org: iBuilding, registrar: iBuilding, address: iLoc, phone: iPhone, fax: iFax, email: iMail, url: iLink,
  role: iRole, title: iTitle, kind: iDot, remark: iNote,
  // 域名 RDAP / WHOIS: 域名 / 名称服务器 / DNSSEC / 注册商
  ldhname: iTag, ns: iNet, dnssec: iShield,
}
export function keyIcon(k) { return KEY_ICON[k] || iDot }

// abuse 角色高亮(盾牌); group/org 用群体图标, 否则个人。
export function roleIcon(roles, kind) {
  if ((roles || []).includes('abuse')) return iShield
  if (kind === 'org' || kind === 'group') return iUsers
  return iUser
}
// email 行: 若是 abuse 实体里的邮箱, 视觉上用 @ 更醒目(留给组件判断)。
export { iAt }
