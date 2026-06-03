// PEER.AS Service Worker — 让 app 壳(HTML + 内容寻址的 /assets/*)重复加载秒开、可离线。
// 不碰数据: /data/*(parquet/json, 体积大且带 ?v= 版本) 与跨源(cn.peer.as)一律放行;
// DuckDB wasm/worker(34MB+, 现也在 /assets/)由前端 Cache Storage 单独管(见 db.js cachedBlobURL),
// 本 SW 放行不入壳缓存, 免与 WASM_CACHE 重复占用配额。
// 升级策略: 改 VERSION 即弃旧壳缓存; skipWaiting + clients.claim 让新版立即接管。
const VERSION = 'v3'   // bump: 新增 /data HEAD 缓存; 清理旧 shell 缓存
const SHELL = `shell-${VERSION}`
const HEAD_CACHE = `data-head-${VERSION}`
const PRECACHE = ['./', './index.html', './favicon.svg', './icons.svg']
// duckdb-wasm 读取 parquet 前会发同步 XHR 的 HEAD 取文件大小/Range 支持(~200ms RTT, 顺序阻塞)。
// 这些头是要缓存的关键字段; 文件 URL 带 ?v=<数据版本> immutable, 故同 URL 的大小永不变 -> 可安全缓存。
const HEAD_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'content-type', 'etag', 'last-modified', 'cache-control']

// /data 同源文件的 HEAD: 首次真实 HEAD 的关键头存进 Cache(用 GET 合成键, 因 Cache API 不收 HEAD 请求),
// 之后同 URL 的 HEAD 本地秒回, 省掉重复 RTT。任何异常都回退网络, 绝不破坏数据加载。
async function headCached(req, url) {
  try {
    const cache = await caches.open(HEAD_CACHE)
    const key = new Request(url.href + (url.search ? '&' : '?') + '__head=1')   // GET 合成键
    const hit = await cache.match(key)
    if (hit) return new Response(null, { status: 200, headers: hit.headers })
    const net = await fetch(req)
    if (net.ok && net.headers.get('content-length') != null) {
      const h = new Headers()
      for (const k of HEAD_HEADERS) { const v = net.headers.get(k); if (v != null) h.set(k, v) }
      if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes')
      // 同名文件的旧版本(?v= 变化)条目清掉, 每文件只留最新一条, 防 daily 刷新后无限堆积。
      for (const k of await cache.keys()) {
        try { if (new URL(k.url).pathname === url.pathname) await cache.delete(k) } catch { /* ignore */ }
      }
      await cache.put(key, new Response(null, { status: 200, headers: h }))   // 归一成 200 存(Cache 拒收 206)
    }
    return net
  } catch {
    try { return await fetch(req) } catch { return Response.error() }
  }
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k =>
      (k.startsWith('shell-') && k !== SHELL) || (k.startsWith('data-head-') && k !== HEAD_CACHE)
    ).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  // duckdb-wasm 对同源 /data parquet 的 HEAD(取大小/Range 支持): 缓存关键头, 省掉重复 ~200ms RTT。
  if (req.method === 'HEAD' && url.origin === location.origin && url.pathname.startsWith('/data/')) {
    e.respondWith(headCached(req, url)); return
  }
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
