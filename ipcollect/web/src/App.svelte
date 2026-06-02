<script>
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from './lib/store.svelte.js'
  import { getData, initDuck, configure, dv } from './lib/db.js'
  import { applyTheme, setLang } from './lib/ui.js'
  import { ccLabel } from './lib/bgp.js'
  import { applyRoute, hardCloseDetail } from './lib/queries.js'
  import { t } from './lib/i18n.js'
  import { iSpinner } from './lib/icons.js'
  import Sidebar from './components/Sidebar.svelte'
  import MobileBar from './components/MobileBar.svelte'
  import Topbar from './components/Topbar.svelte'
  import Results from './components/Results.svelte'
  import InsightDrawer from './components/InsightDrawer.svelte'
  import AboutModal from './components/AboutModal.svelte'
  import ChangelogModal from './components/ChangelogModal.svelte'
  import PathHelpModal from './components/PathHelpModal.svelte'

  let fatal = $state('')

  // 随语言本地化 <head>: title / lang / description (切英文时 title 也变英文)。
  $effect(() => {
    document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en'
    document.title = t('page_title')
    const d = document.querySelector('meta[name="description"]')
    if (d) d.setAttribute('content', t('page_desc'))
  })

  onMount(async () => {
    applyTheme(localStorage.getItem('ipc-theme') || 'auto')
    const qp = new URLSearchParams(location.search)
    setLang(qp.get('lang') || localStorage.getItem('ipc-lang')
      || ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'))
    const dw = parseFloat(localStorage.getItem('ipc-detail-w')); if (dw) S.detailW = Math.min(72, Math.max(38, dw))

    // 选定数据宿主: CN 用户(/cdn-cgi/trace loc=CN)且 VPS 健康 -> cn.peer.as, 否则同源 CF。
    // wasm 同源打包(CN 完整自托管); CF 节点超 25MiB 的 wasm 回退外部 CDN(见 db.js wasmSrcs)。
    // edge 存入 store, 供空状态显示「正在使用中国优化服务器」赞助提示。
    S.edge = await configure()

    // meta.json 必须拿最新的(它带 version, 决定其它文件的 ?v=); no-cache 强制条件请求(未变则 304, 变了取新)。
    // getData 带回退: 选定宿主(可能是 CN VPS)失败时整体回退 CF。
    try { S.meta = await getData('/meta.json', { cache: 'no-cache' }) }
    catch (e) { fatal = `meta.json: ${e.message}（先跑 ipc export-parquet）`; S.loading = false; return }

    const cc0 = qp.get('cc'); if (cc0) S.filters.cc = ccLabel(cc0.toUpperCase())
    const city0 = qp.get('city'); if (city0) S.filters.city = city0

    S.msg = t('loading')
    // 全量 ASN 名(~1MB)与 org 表与 DuckDB 初始化并行加载; 失败则降级到 meta 里的精选名。
    const asnP = getData(`/asnames.json${dv()}`).then(n => { S.asnNames = n }).catch(() => {})
    const orgP = getData(`/asnorg.json${dv()}`).then(o => { S.asnOrg = o }).catch(() => {})
    try { await initDuck() } catch (e) { fatal = `DuckDB-WASM: ${e.message}`; S.loading = false; return }
    try { await asnP } catch (e) { /* 可选, 忽略 */ }
    try { await orgP } catch (e) { /* 可选, 忽略 */ }
    S.ready = true; S.loading = false; S.msg = ''
    // 解析当前 URL(路径 /<asn|prefix> 或 ?q=) 渲染; 浏览器前进/后退经 popstate 重渲染(PJAX)。
    applyRoute({ initial: true })
    window.addEventListener('popstate', () => applyRoute())

    window.addEventListener('keydown', e => { if (e.key === 'Escape') { S.about = false; S.changelog = false; S.pathHelp = false; S.menu = false; if (S.detailKind) hardCloseDetail() } })
  })
</script>

<div class="app">
  <Sidebar />
  <main class="main">
    <MobileBar />
    <Topbar />
    <div class="content">
      {#if fatal}
        <div class="fatal"><b>×</b> {fatal}</div>
      {:else if S.loading}
        <div class="boot"><Fa icon={iSpinner} spin /> <span>{S.msg || t('loading')}</span></div>
      {:else}
        <Results />
      {/if}
    </div>
  </main>
  <InsightDrawer />
</div>
<AboutModal />
<ChangelogModal />
<PathHelpModal />

<style>
  .app { display: flex; min-height: 100vh; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  /* flex 列: 让空状态的赞助条用 margin-top:auto 贴到底部; 底 padding 14px 与侧栏 .foot 对齐 */
  .content { flex: 1; padding: 6px 18px 14px; display: flex; flex-direction: column; }
  .boot { padding: 70px 20px; text-align: center; color: var(--muted); font: 13px var(--mono); display: flex; align-items: center; justify-content: center; gap: 10px; }
  .boot :global(svg) { color: var(--accent); }
  .fatal { padding: 40px 20px; color: #e06c6c; font-size: 13px; }
  .fatal b { color: #e06c6c; }
  @media (max-width: 820px) {
    .app { flex-direction: column; }
    .content { padding: 4px 12px 24px; }
  }
</style>
