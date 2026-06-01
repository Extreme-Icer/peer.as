// DuckDB-WASM 数据层 (从 web_ref/app.js 移植)。无后端: 浏览器对静态 parquet 发 HTTP Range 查询。
import { S } from './store.svelte.js'

const DUCKDB_VER = '1.32.0'
const JSDELIVR = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VER}/dist`

// 数据/wasm 宿主基址在「运行时」按地区选定(见 configure)。绝对 URL: DuckDB-WASM 在 Web Worker
// 里 fetch, 相对路径会相对 worker 脚本 -> 必须绝对。
// - CF/同源 = 默认(海外快, 免费出口); VITE_DATA_BASE 可把数据指到独立宿主(R2 等)。
// - CN 命中 = 切到中国优化 VPS(cn.peer.as): parquet 走 /data, 自托管 duckdb wasm 走 /duckdb。
//   该宿主须支持 HTTP Range(206) 且 CORS 暴露 Content-Range 等头(Caddy 已配)。
const CF_DATA = (import.meta.env.VITE_DATA_BASE || new URL('./data', document.baseURI).href).replace(/\/$/, '')
const CN_ORIGIN = (import.meta.env.VITE_CN_BASE || 'https://cn.peer.as').replace(/\/$/, '')

// 运行时选定(默认 CF/jsDelivr); configure() 探测 geo=CN 且 VPS 健康时改写。
export let DATA = CF_DATA          // parquet/json 基址。ES module 活绑定: 重新赋值后各处即时生效。
let DUCK_SRC = null                // null => jsDelivr 官方 bundle; 否则自托管 dist 基址(CN)。
export let edge = 'cf'             // 'cf' | 'cn', 仅诊断用。

let db = null, conn = null

// 带超时的 fetch(超时即 abort; 用于 geo 探测/健康检查, 不拖慢启动)。
async function fetchT(url, opts = {}, ms = 2000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) } finally { clearTimeout(t) }
}

// 启动时调用一次: 选定数据/wasm 宿主。CN 且 VPS 可达 -> VPS; 否则 CF/jsDelivr 回退。
// geo 判定走 Cloudflare 同源 /cdn-cgi/trace(loc=CN); 本地/非 CF 环境 trace 不存在 -> 当作非 CN。
export async function configure() {
  DATA = CF_DATA; DUCK_SRC = null; edge = 'cf'
  let loc = null
  try {
    const r = await fetchT('/cdn-cgi/trace', { cache: 'no-store' }, 1200)
    if (r.ok) loc = (/(?:^|\n)loc=([A-Z]{2})/.exec(await r.text()) || [])[1]
  } catch { /* 无 trace -> 当作非 CN */ }
  if (loc === 'CN') {
    try {                                   // 健康探测 VPS: 通了才切, 失败保持 CF(错误回退)。
      const r = await fetchT(`${CN_ORIGIN}/data/meta.json`, { cache: 'no-store' }, 2000)
      if (r.ok) { DATA = `${CN_ORIGIN}/data`; DUCK_SRC = `${CN_ORIGIN}/duckdb`; edge = 'cn' }
    } catch { /* VPS 不可达 -> CF 回退 */ }
  }
  return edge
}

export async function getJSON(url, opts) {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

// meta/asnames 等关键 JSON 的「带回退」取数: 先试选定宿主(可能是 CN VPS), 失败则整体回退 CF
// 并把后续数据源也切回 CF(consistent fallback)。path 形如 `/meta.json`、`/asnames.json?v=…`。
export async function getData(path, opts) {
  try { return await getJSON(`${DATA}${path}`, opts) }
  catch (e) {
    if (DATA !== CF_DATA) { DATA = CF_DATA; DUCK_SRC = null; edge = 'cf'; return await getJSON(`${CF_DATA}${path}`, opts) }
    throw e
  }
}

// 数据版本查询串: meta.version 拼成 ?v=<hash>。数据一变 version 就变 -> URL 变 -> 旧缓存(浏览器/CDN)失效。
// 所有 parquet/asnames URL 都带上它; 因此即便 parquet 长缓存(max-age=86400)也不会读到过期数据。
export const dv = () => { const v = S.meta?.version; return v ? `?v=${encodeURIComponent(v)}` : '' }

const WASM_CACHE = `duckdb-wasm-${DUCKDB_VER}`   // 版本入名: 升级 duckdb 自动弃旧缓存

// 把大体积 wasm/worker 存进 Cache Storage, 以 blob: URL 交给 duckdb。
// 为何不靠浏览器 HTTP 缓存: eh.wasm 解压后 34MB, 超出磁盘缓存单资源上限 -> 每次刷新都重下;
// Cache Storage 无此限制, 存一次后每次加载本地命中(CN 时首装来自 VPS 优化线, 不碰 jsDelivr)。
// 键与宿主无关(稳定), 切换地区不会重复缓存; urls 按序尝试, 主源(可能是 CN)失败回退 jsDelivr。
async function cachedBlobURL(key, urls, type) {
  const req = `${location.origin}/__duckdbwasm__/${key}`
  let cache, resp
  try { cache = await caches.open(WASM_CACHE); resp = await cache.match(req) } catch { /* 无 Cache API */ }
  if (!resp) {
    let err
    for (const u of urls) {
      try { const r = await fetch(u); if (r.ok) { resp = r; break } err = new Error(`${u} → ${r.status}`) }
      catch (e) { err = e }
    }
    if (!resp) throw err
    try { if (cache) await cache.put(req, resp.clone()) } catch { /* 配额/无痕: 不缓存也能用 */ }
  }
  const buf = await resp.arrayBuffer()
  return URL.createObjectURL(new Blob([buf], type ? { type } : undefined))
}

export async function initDuck() {
  // duckdb-wasm 加载器(JS API, 小)仍走 jsDelivr; /* @vite-ignore */ 让 Vite 不解析远程 URL。
  const duckdb = await import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VER}/+esm`)
  // 候选 bundle: CN 用自托管 dist, 否则 jsDelivr 官方。selectBundle 按浏览器特性挑 mvp/eh。
  const src = DUCK_SRC || JSDELIVR
  const picked = await duckdb.selectBundle({
    mvp: { mainModule: `${src}/duckdb-mvp.wasm`, mainWorker: `${src}/duckdb-browser-mvp.worker.js` },
    eh:  { mainModule: `${src}/duckdb-eh.wasm`,  mainWorker: `${src}/duckdb-browser-eh.worker.js` },
  })
  const variant = picked.mainModule.includes('mvp') ? 'mvp' : 'eh'
  // worker.js + 大 wasm 都过 Cache Storage(跨刷新命中); 主源失败回退 jsDelivr 官方 dist。
  const workerUrl = await cachedBlobURL(`${variant}.worker.js`,
    [picked.mainWorker, `${JSDELIVR}/duckdb-browser-${variant}.worker.js`], 'text/javascript')
  const wasmUrl = await cachedBlobURL(`${variant}.wasm`,
    [picked.mainModule, `${JSDELIVR}/duckdb-${variant}.wasm`], 'application/wasm')

  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(wasmUrl, picked.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  URL.revokeObjectURL(wasmUrl)   // instantiate 已读完 wasm, 释放 blob
  conn = await db.connect()
}

// 跑 SQL, 返回普通对象数组 (顶层 BigInt -> Number)
export async function q(sql) {
  const res = await conn.query(sql)
  return res.toArray().map(row => {
    const o = row.toJSON()
    for (const k in o) if (typeof o[k] === 'bigint') o[k] = Number(o[k])
    return o
  })
}

// HTTP 不支持 glob -> 用 meta.files 的显式文件清单; 每个 URL 带 ?v=<数据版本> 做缓存失效。
export const rpList = files => `read_parquet([${(files || []).map(f => `'${DATA}/parquet/${f}${dv()}'`).join(',')}])`
export const rp = name => rpList((S.meta?.files || {})[name])

// paths 分多文件; 用 paths_pid 区间只读命中那 1 个文件
export function pathsFileFor(pid) {
  const idx = S.meta?.files?.paths_pid || []
  const hits = idx.filter(e => pid >= e.lo && pid <= e.hi)
  return hits.length ? hits.map(e => e.f) : (S.meta?.files?.paths || [])
}

// pathsearch 按 origin_asn 排序 + meta.pathsearch_origin 区间索引:
// origin AS 搜索只读覆盖该 ASN 的文件。返回 null = 库内无该 origin(前端直接给空结果, 不发查询)。
// 无 origin 过滤(纯 AS_PATH 搜索) -> 返回全部分片(全表扫)。
export function pathsearchFilesForOrigin(originAsn) {
  const all = S.meta?.files?.pathsearch || []
  const idx = S.meta?.files?.pathsearch_origin
  if (originAsn == null || !Array.isArray(idx) || !idx.length) return all
  const hit = idx.filter(e => e.lo != null && e.hi != null && originAsn >= e.lo && originAsn <= e.hi)
  return hit.length ? hit.map(e => e.f) : null   // null: 索引完整但无文件覆盖 -> 该 origin 不存在
}

// 多个 origin ASN -> 覆盖它们的 pathsearch 文件并集(去重)。任一命中即收, 全都无覆盖才返回 null。
// 无区间索引时回退到全部分片(全表扫)。
export function pathsearchFilesForOrigins(asns) {
  const all = S.meta?.files?.pathsearch || []
  const idx = S.meta?.files?.pathsearch_origin
  if (!Array.isArray(asns) || !asns.length) return all
  if (!Array.isArray(idx) || !idx.length) return all
  const set = new Set()
  for (const a of asns)
    for (const e of idx)
      if (e.lo != null && e.hi != null && a >= e.lo && a <= e.hi) set.add(e.f)
  return set.size ? [...set] : null
}
