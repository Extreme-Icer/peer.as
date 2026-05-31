// DuckDB-WASM 数据层 (从 web_ref/app.js 移植)。无后端: 浏览器对静态 parquet 发 HTTP Range 查询。
import { S } from './store.svelte.js'

const DUCKDB_VER = '1.32.0'
// 绝对 URL: DuckDB-WASM 在 Web Worker 里 fetch, 相对路径会相对 worker 脚本 -> 必须绝对。
export const DATA = new URL('./data', document.baseURI).href.replace(/\/$/, '')
export const PQ = `${DATA}/parquet`

let db = null, conn = null

export async function getJSON(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

export async function initDuck() {
  // CDN 动态 import; /* @vite-ignore */ 让 Vite 不解析这个远程 URL。
  const duckdb = await import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VER}/+esm`)
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
  const workerUrl = URL.createObjectURL(new Blob(
    [`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: 'text/javascript' }))
  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
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

// HTTP 不支持 glob -> 用 meta.files 的显式文件清单
export const rpList = files => `read_parquet([${(files || []).map(f => `'${PQ}/${f}'`).join(',')}])`
export const rp = name => rpList((S.meta?.files || {})[name])

// paths 分多文件; 用 paths_pid 区间只读命中那 1 个文件
export function pathsFileFor(pid) {
  const idx = S.meta?.files?.paths_pid || []
  const hits = idx.filter(e => pid >= e.lo && pid <= e.hi)
  return hits.length ? hits.map(e => e.f) : (S.meta?.files?.paths || [])
}
