import { S } from './store.svelte.js'

export function applyTheme(th) {
  S.theme = th
  const r = document.documentElement
  if (th === 'light' || th === 'dark') r.setAttribute('data-theme', th); else r.removeAttribute('data-theme')
  if (th === 'auto') localStorage.removeItem('ipc-theme'); else localStorage.setItem('ipc-theme', th)
}
export function cycleTheme() {
  const order = ['auto', 'light', 'dark']
  applyTheme(order[(order.indexOf(S.theme) + 1) % order.length])
}
export function setLang(l) {
  S.lang = (l === 'en') ? 'en' : 'zh'
  localStorage.setItem('ipc-lang', S.lang)
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en'
}
export function toggleLang() { setLang(S.lang === 'zh' ? 'en' : 'zh') }
