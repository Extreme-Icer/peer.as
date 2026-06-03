// 站点 Profile / Feature Flags(前端侧)—— 与后端 ipcollect/profile.py 对应。
// 由构建期环境变量 VITE_SITE 选定(默认 'peeras'); 同后端约定: peeras = 现状全开。
//
// 用法:  import { SITE, features } from './lib/site.js'
//        if (features.geo) { ...地区导航... }
//
// **Phase 1 仅落地此模块, 组件尚未接线**(地区导航/RDAP 去留是 Phase 2 = 实现 dn42 前端)。
// 维护铁律(见 AGENTS.md「站点 Profile」): 差异靠开关关成 no-op, 不靠删代码分叉。

export const SITE = (import.meta.env.VITE_SITE || 'peeras')

const PROFILES = {
  peeras: {
    geo: true,         // 地区(国家/城市)导航 + geo 数据视图
    rdapWhois: true,   // whois 走公网 RDAP 直连 + 兜底 worker(dn42 改 registry 静态数据)
    dns: true,         // DNS 解析视图(DoH)
  },
  dn42: {
    geo: false,
    rdapWhois: false,  // whois 走静态 registry JSON
    dns: false,        // 无 DoH 解析; 但域名仍可查 registry whois(见 queries.js)
  },
}

export const features = PROFILES[SITE] || PROFILES.peeras

// 站点 logo / 品牌(结构性, 非 i18n)。.hi 段用 accent 高亮。
const BRANDS = {
  peeras: { main: 'PEER', hi: '.AS' },
  dn42: { main: 'DN42.PEER', hi: '.AS' },
}
export const brand = BRANDS[SITE] || BRANDS.peeras
