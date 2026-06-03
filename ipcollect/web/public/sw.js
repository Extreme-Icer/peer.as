// PEER.AS Service Worker — 让 app 壳(HTML + 内容寻址的 /assets/*)重复加载秒开、可离线。
// 不碰数据: /data/*(parquet/json, 体积大且带 ?v= 版本) 与跨源(cn.peer.as)一律放行;
// DuckDB wasm/worker(34MB+, 现也在 /assets/)由前端 Cache Storage 单独管(见 db.js cachedBlobURL),
// 本 SW 放行不入壳缓存, 免与 WASM_CACHE 重复占用配额。
// 升级策略: 改 VERSION 即弃旧壳缓存; skipWaiting + clients.claim 让新版立即接管。
const VERSION = 'v4'   // bump: 全 GET 模式, 移除 /data HEAD 缓存(duckdb 不再发 HEAD); 清理旧 head 缓存
const SHELL = `shell-${VERSION}`
const PRECACHE = ['./', './index.html', './favicon.svg', './icons.svg']
// 注: duckdb-wasm 已切全 GET(db.js forceFullHTTPReads), 读 parquet 前不再发 HEAD, 故本 SW 不再
// 拦截/缓存 /data HEAD —— 每个分片是普通 GET(200), 直接由浏览器 HTTP 缓存(max-age=1y + ?v=)接管。

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k =>
      (k.startsWith('shell-') && k !== SHELL) || k.startsWith('data-head-')   // 旧 HEAD 缓存全清(已弃用)
    ).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET') return
  if (url.origin !== location.origin) return         // 跨源(cn.peer.as / wasm CDN 回退): 放行
  if (url.pathname.startsWith('/data/')) return       // 数据 GET(带 ?v=): 放行, 不入壳缓存
  if (url.pathname.startsWith('/cdn-cgi/')) return    // CF trace 等: 放行
  // DuckDB wasm/worker(大, 由 db.js 的 Cache Storage/WASM_CACHE 单独管): 放行, 不入壳缓存避免重复占配额。
  if (/\.wasm$/.test(url.pathname) || /\.worker-[^/]*\.js$/.test(url.pathname)) return

  // 导航(HTML): network-first + 离线回退缓存。保证拿到最新 HTML(含正确的 hashed 资源名),
  // 避免「陈旧 HTML 指向已被新部署删除的旧 hash 资源」而 404。
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req)
        const c = await caches.open(SHELL); c.put('./index.html', net.clone())
        return net
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error()
      }
    })())
    return
  }

  // 内容寻址的静态资源(/assets/*, 文件名含 hash, immutable): cache-first(命中即本地秒回)。
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const net = await fetch(req)
      if (net.ok) { const c = await caches.open(SHELL); c.put(req, net.clone()) }
      return net
    })())
    return
  }

  // 其它同源小文件(favicon/icons/manifest 等): stale-while-revalidate。
  e.respondWith((async () => {
    const hit = await caches.match(req)
    const netP = fetch(req).then(net => {
      if (net.ok) caches.open(SHELL).then(c => c.put(req, net.clone()))
      return net
    }).catch(() => null)
    return hit || (await netP) || Response.error()
  })())
})
