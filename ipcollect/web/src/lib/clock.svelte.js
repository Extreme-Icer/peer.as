// 相对时间("x小时x分前")+ UTC 绝对时间(hover 显示)。供「生成」时间展示用。
// 模块级 $state `now` 每 30s 自走一次, 读它的 genAgo() 在模板里就能随时间推进自动刷新。
import { S } from './store.svelte.js'

let now = $state(Date.now())
if (typeof window !== 'undefined') setInterval(() => { now = Date.now() }, 30000)

// 距 ts(epoch 秒)多久之前 —— 中文 "x天x小时前 / x小时x分前 / x分前 / 刚刚", 英文同义。
export function genAgo(ts) {
  if (!ts) return '—'
  const zh = S.lang === 'zh'
  let s = Math.max(0, Math.floor(now / 1000) - Number(ts))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return zh ? `${d}天${h}小时前` : `${d}d ${h}h ago`
  if (h > 0) return zh ? `${h}小时${m}分前` : `${h}h ${m}m ago`
  if (m > 0) return zh ? `${m}分前` : `${m}m ago`
  return zh ? '刚刚' : 'just now'
}

// ts(epoch 秒)→ "YYYY-MM-DD HH:MM UTC"(给 title tooltip)。
export function genUtc(ts) {
  if (!ts) return ''
  const dt = new Date(Number(ts) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())} UTC`
}
