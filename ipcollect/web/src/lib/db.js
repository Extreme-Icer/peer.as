// DuckDB-WASM 数据层 (从 web_ref/app.js 移植)。无后端: 浏览器对静态 parquet 发 HTTP Range 查询。
import { S } from './store.svelte.js'
// DuckDB-WASM 全部自托管(无 jsDelivr 运行时依赖): JS API 经 Vite 动态 import 打成同源 chunk;
// wasm/worker 用 `?url` 引入 -> Vite 输出带内容 hash 的独立资源(不内联到 JS), 随 dist 一并部署到
// CF Pages 与 CN 镜像(daily-refresh rsync)。两边 hash 路径一致 -> 境内数据切 CN 时 wasm 也能走 CN 优化线(见 wasmSrcs)。
import wasmMvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import workerMvp from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import wasmEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerEh from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

const DUCKDB_VER = '1.32.0'

// 数据宿主在「运行时」按域名/地区选定(见 configure)。**默认全部走同源**(peer.as 自己的 /data;已弃用 R2,
// 因为前端实际是整片下载、不靠 Range,R2 只徒增被刷爆的 egress 账单风险)。
// - 同源 = 默认: 海外走 CF Pages 的 /data; GeoDNS 把境内 peer.as 解到 CN 机器时, 同源即 CN 机器(快)。
// - cn.peer.as 直连 = 全部同源相对(数据 /data)。
// - 境内但 GeoDNS 没生效(拿到 CF IP): /cdn-cgi/trace=CN 时把数据切到 cn.peer.as(带回退同源)。
// wasm/worker 已随构建打包同源, 无需再选宿主; 仅在数据切到 CN 时让 wasm 也优先走 CN 镜像(wasmSrcs)。
const SAME = new URL('./data', document.baseURI).href.replace(/\/$/, '')       // 同源 /data
const CN_ORIGIN = (import.meta.env.VITE_CN_BASE || 'https://cn.peer.as').replace(/\/$/, '')
let CN_HOST = 'cn.peer.as'; try { CN_HOST = new URL(CN_ORIGIN).hostname } catch { /* 默认 cn.peer.as */ }

// 运行时选定(默认同源); configure() 据域名/geo 改写。
export let DATA = SAME             // parquet/json 基址。ES module 活绑定: 重新赋值后各处即时生效。
export let edge = 'cf'             // 'cf' | 'cn', 仅诊断用。

// 把打包出的 wasm/worker 资产路径(可能是同源绝对 URL)展开成「按序尝试」的候选: 数据切到 CN 镜像时,
// 同一 hash 资产在 CN 镜像也存在(随 dist rsync) -> 优先 CN 优化线、回退同源。其余情况只用同源。
function wasmSrcs(assetUrl) {
  const abs = new URL(assetUrl, document.baseURI)
  if (DATA.startsWith(CN_ORIGIN)) return [`${CN_ORIGIN}${abs.pathname}`, abs.href]
  return [abs.href]
}

let db = null, conn = null

// 带超时的 fetch(超时即 abort; 用于 geo 探测/健康检查, 不拖慢启动)。
async function fetchT(url, opts = {}, ms = 2000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) } finally { clearTimeout(t) }
}

// 启动时调用一次: 选定数据宿主(wasm/worker 已打包同源, 见 wasmSrcs)。
export async function configure() {
  DATA = SAME; edge = 'cf'
  // 1) 直连 CN 机器(host=cn.peer.as): 同源即 CN 机器 —— 数据 /data 同源。
  if (location.hostname === CN_HOST) {
    DATA = SAME; edge = 'cn'
    return edge
  }
  // 2) 否则: 探 /cdn-cgi/trace 判断当前在 Cloudflare 还是 CN 加速机。
  //    CF 上: 200 + 含 loc=XX。CN 加速机(GeoDNS 把 peer.as 解到本机)/本地 serve: 无此端点 -> 404。
  let onCF = false, loc = null
  try {
    const r = await fetchT('/cdn-cgi/trace', { cache: 'no-store' }, 1200)
    if (r.ok) { onCF = true; loc = (/(?:^|\n)loc=([A-Z]{2})/.exec(await r.text()) || [])[1] }
    // r 收到但非 200(典型 404) -> onCF 保持 false -> 判定走了 CN 加速机(见下)。
  } catch { /* 网络错误(非 404 响应): 含糊, 不强判, 保持 CF 默认 */ onCF = null }
  if (onCF === false) {
    // /cdn-cgi/trace 明确 404(收到响应但非 200) => 不在 Cloudflare => GeoDNS 已把 peer.as 解到 CN 加速机
    // (或本地 serve)。数据同源(本机即正确源); edge=cn 让 UI 显示「中国优化服务器」赞助提示。
    edge = 'cn'
  } else if (onCF && loc === 'CN') {        // 在 CF Pages 且身处境内(GeoDNS 没生效, 拿到 CF IP)
    try {                                   // 健康探测 CN 机器: 通了才切数据, 失败保持同源 CF(回退)。
      const r = await fetchT(`${CN_ORIGIN}/data/meta.json`, { cache: 'no-store' }, 2000)
      if (r.ok) { DATA = `${CN_ORIGIN}/data`; edge = 'cn' }   // wasm 随之优先走 CN 镜像(wasmSrcs)
    } catch { /* CN 机器不可达 -> 同源 CF 回退 */ }
  }
  // else: onCF && loc!=CN (海外 CF), 或 onCF===null(网络错误) -> 同源, edge='cf'
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
    // 数据源(可能是 cn.peer.as)取数失败 -> 整体回退同源(CF Pages / 本机)。
    if (DATA !== SAME) { DATA = SAME; edge = 'cf'; return await getJSON(`${SAME}${path}`, opts) }
    throw e
  }
}

// 数据版本查询串: meta.version 拼成 ?v=<hash>。数据一变 version 就变 -> URL 变 -> 旧缓存(浏览器/CDN)失效。
// 所有 parquet/asnames URL 都带上它; 因此即便 parquet 长缓存(max-age=86400)也不会读到过期数据。
export const dv = () => { const v = S.meta?.version; return v ? `?v=${encodeURIComponent(v)}` : '' }

const WASM_CACHE = `duckdb-wasm-${DUCKDB_VER}`   // 版本入名: 升级 duckdb 自动弃旧缓存

// 把大体积 wasm/worker 存进 Cache Storage, 以 blob: URL 交给 duckdb。
// 为何不靠浏览器 HTTP 缓存: eh.wasm 解压后 34MB, 超出磁盘缓存单资源上限 -> 每次刷新都重下;
// Cache Storage 无此限制, 存一次后每次加载本地命中(资产同源打包; CN 时首装走 VPS 优化线)。
// 键与宿主无关(稳定), 切换地区不会重复缓存; urls 按序尝试, 主源(可能是 CN 镜像)失败回退同源。
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
  // JS API: 动态 import 打包出的同源 chunk(惰性加载, 不进首屏; 不再碰 jsDelivr)。
  const duckdb = await import('@duckdb/duckdb-wasm')
  // 候选 bundle 指向打包资产(?url); selectBundle 按浏览器特性挑 mvp/eh。
  const picked = await duckdb.selectBundle({
    mvp: { mainModule: wasmMvp, mainWorker: workerMvp },
    eh:  { mainModule: wasmEh,  mainWorker: workerEh },
  })
  const variant = picked.mainModule === wasmEh ? 'eh' : 'mvp'
  // worker.js + 大 wasm 都过 Cache Storage(跨刷新命中); wasmSrcs 给出 CN 镜像优先/同源回退的候选。
  const workerUrl = await cachedBlobURL(`${variant}.worker.js`,
    wasmSrcs(picked.mainWorker), 'text/javascript')
  const wasmUrl = await cachedBlobURL(`${variant}.wasm`,
    wasmSrcs(picked.mainModule), 'application/wasm')

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

// paths 分多文件(v4 + v6); pid 全局唯一且两族不交 -> 合查两族 paths_pid 区间, 命中即只读那 1 个文件。
export function pathsFileFor(pid) {
  const idx = [...(S.meta?.files?.paths_pid || []), ...(S.meta?.files?.paths_pid_v6 || [])]
  const hits = idx.filter(e => pid >= e.lo && pid <= e.hi)
  return hits.length ? hits.map(e => e.f)
    : [...(S.meta?.files?.paths || []), ...(S.meta?.files?.paths_v6 || [])]
}

// 全局搜索的 pathsearch 文件全集(v4 + v6)。
const _psAll = () => [...(S.meta?.files?.pathsearch || []), ...(S.meta?.files?.pathsearch_v6 || [])]
const _psOriginIdx = () => [...(S.meta?.files?.pathsearch_origin || []), ...(S.meta?.files?.pathsearch_origin_v6 || [])]

// pathsearch 按 origin_asn 排序 + 区间索引(两族): origin AS 搜索只读覆盖该 ASN 的文件。
// 返回 null = 两族都无该 origin(直接给空结果, 不发查询)。无 origin 过滤 -> 返回全部分片(全表扫)。
export function pathsearchFilesForOrigin(originAsn) {
  const idx = _psOriginIdx()
  if (originAsn == null || !idx.length) return _psAll()
  const hit = idx.filter(e => e.lo != null && e.hi != null && originAsn >= e.lo && originAsn <= e.hi)
  return hit.length ? hit.map(e => e.f) : null
}

// 多个 origin ASN -> 覆盖它们的 pathsearch 文件并集(两族)。全都无覆盖才返回 null。
export function pathsearchFilesForOrigins(asns) {
  const idx = _psOriginIdx()
  if (!Array.isArray(asns) || !asns.length || !idx.length) return _psAll()
  const set = new Set()
  for (const a of asns)
    for (const e of idx)
      if (e.lo != null && e.hi != null && a >= e.lo && a <= e.hi) set.add(e.f)
  return set.size ? [...set] : null
}
