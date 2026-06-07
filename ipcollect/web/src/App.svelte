<script>
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from './lib/store.svelte.js'
  import { getData, configure, ensureEngine } from './lib/db.js'
  import { applyTheme, setLang } from './lib/ui.js'
  import { ccLabel } from './lib/bgp.js'
  import { applyRoute, hardCloseDetail } from './lib/queries.js'
  import { t } from './lib/i18n.js'
  import { brand, features } from './lib/site.js'
  import { iSpinner } from './lib/icons.js'
  import Sidebar from './components/Sidebar.svelte'
  import MobileBar from './components/MobileBar.svelte'
  import Topbar from './components/Topbar.svelte'
  import WhoisView from './components/WhoisView.svelte'
  import Results from './components/Results.svelte'
  import DnsView from './components/DnsView.svelte'
  import AsSetView from './components/AsSetView.svelte'
  import InsightDrawer from './components/InsightDrawer.svelte'
  import AboutModal from './components/AboutModal.svelte'
  import ChangelogModal from './components/ChangelogModal.svelte'
  import PathHelpModal from './components/PathHelpModal.svelte'
  import ExportModal from './components/ExportModal.svelte'

  // 当前正在查看的详情(prefix/asn/domain/dns)对应的页标题 —— 让每个 pushState 历史项可辨识(便于翻历史记录)；
  // 无详情时回落默认页标题。随详情状态 + 语言响应式变化(与 queries.js 的 go() pushState 同源, 故历史项标题对应正确)。
  function pageTitle() {
    const B = brand.main + brand.hi
    if (S.view === 'whois') return `${S.whois?.input ? S.whois.input + ' · ' : ''}WHOIS · ${B}`
    if (S.detailKind === 'prefix' && S.insight?.prefix) return `${S.insight.prefix} · ${B}`
    if (S.detailKind === 'asn' && S.asnView) {
      const n = S.asnView.name
      return `AS${S.asnView.asn}${n ? ' ' + n : ''} · ${B}`
    }
    if (S.detailKind === 'domain' && S.domainView?.domain) return `${S.domainView.domain} · ${B}`
    if (S.mode === 'dns' && S.dns?.domain) return `${S.dns.domain} · ${B}`   // 移动端无右侧面板时仍用域名
    return t('page_title')
  }

  // 随语言/详情本地化 <head>: title / lang / description (切英文时 title 也变英文; 切详情时 title 变成正在看的对象)。
  $effect(() => {
    document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en'
    document.title = pageTitle()
    const d = document.querySelector('meta[name="description"]')
    if (d) d.setAttribute('content', t('page_desc'))
  })

  onMount(async () => {
    applyTheme(localStorage.getItem('ipc-theme') || 'auto')
    S.advWhois = localStorage.getItem('ipc-adv-whois') === '1'   // 「高级搜索」记忆态
    const qp = new URLSearchParams(location.search)
    setLang(qp.get('lang') || localStorage.getItem('ipc-lang')
      || ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'))
    const dw = parseFloat(localStorage.getItem('ipc-detail-w')); if (dw) S.detailW = Math.min(72, Math.max(38, dw))

    // peeras 首页(/, 无 ?q)与 /whois 深链 = WHOIS 视图: 不依赖引擎/meta, 立刻**同步**解析并渲染终态。
    // 关键: 不能只切 view 而把目标留到下面 await 之后再解析 —— 否则首帧落在 WHOIS 首页(地球/立体字可见),
    // 等 meta 拉完才 applyRoute 出详情, 会从首页"动画收起"到详情。这里同步 applyRoute, 让首帧直接就是详情/首页终态。
    const whoisLanding = features.whoisView && (/^\/whois(\/|$)/.test(location.pathname) || (location.pathname === '/' && !qp.has('q')))
    if (whoisLanding) { S.view = 'whois'; S.loading = false; applyRoute({ initial: true }) }

    // 选定数据宿主: CN 用户(/cdn-cgi/trace loc=CN)且 VPS 健康 -> cn.peer.as, 否则同源 CF。
    // wasm 同源打包(CN 完整自托管); CF 节点超 25MiB 的 wasm 回退外部 CDN(见 db.js wasmSrcs)。
    // edge 存入 store, 供空状态显示「正在使用中国优化服务器」赞助提示。
    S.edge = await configure()

    // 路由监听 + Esc 尽早注册(独立于数据/引擎): 直开 /whois 也要能 PJAX 前进后退、Esc。
    window.addEventListener('popstate', () => applyRoute())
    window.addEventListener('keydown', e => { if (e.key === 'Escape') { S.about = false; S.changelog = false; S.pathHelp = false; S.menu = false; S.exportOpen = false; if (S.detailKind) hardCloseDetail() } })

    // meta.json 必须拿最新的(它带 version, 决定其它文件的 ?v=); no-cache 强制条件请求(未变则 304, 变了取新)。
    // getData 带回退: 选定宿主(可能是 CN VPS)失败时整体回退 CF。失败置 fatal(路由视图显示), 但不 return ——
    // WHOIS 视图不依赖 meta, 仍要能用; 故继续 applyRoute。
    try { S.meta = await getData('/meta.json', { cache: 'no-cache' }) }
    catch (e) { S.fatal = `meta.json: ${e.message}（先跑 ipc export-parquet）` }

    const cc0 = qp.get('cc'); if (cc0) S.filters.cc = ccLabel(cc0.toUpperCase())
    const city0 = qp.get('city'); if (city0) S.filters.city = city0

    // 解析当前 URL 渲染。WHOIS 落地页上面已同步解析完, 这里只处理路由分析分支(先 await ensureEngine():
    // 34MB DuckDB + 全量 ASN 名按需懒加载, 期间保持 loading 转圈)。前进/后退经 popstate 重渲染(PJAX)。
    if (!whoisLanding) applyRoute({ initial: true })

    // 落地在 WHOIS 首页时, 引擎本不会加载。空闲时**静默后台预载**(ensureEngine 幂等), 这样之后切到「路由分析」无感秒开;
    // 不阻塞首屏/RDAP, 也不影响 WHOIS 视图(其忽略 S.loading)。meta 缺失则跳过(路由本就不可用)。
    if (S.view === 'whois' && S.meta) {
      const idle = window.requestIdleCallback || (cb => setTimeout(cb, 1500))
      idle(() => ensureEngine().catch(() => {}))
    }
  })
</script>

<div class="app">
  <Sidebar />
  {#if S.view === 'whois'}
    <!-- WHOIS·RDAP 独立视图(自带 MobileBar + 全宽 record, 无 Topbar 过滤器 / 无右侧详情面板) -->
    <WhoisView />
  {:else}
    <main class="main">
      <MobileBar />
      <Topbar />
      <div class="content">
        {#if S.fatal}
          <div class="fatal"><b>×</b> {S.fatal}</div>
        {:else if S.loading}
          <div class="boot"><Fa icon={iSpinner} spin /> <span>{S.msg || t('loading')}</span></div>
        {:else if S.mode === 'dns'}
          <DnsView />
        {:else if S.mode === 'asset'}
          <AsSetView />
        {:else}
          <Results />
        {/if}
      </div>
    </main>
    <InsightDrawer />
  {/if}
</div>
<AboutModal />
<ChangelogModal />
<PathHelpModal />
<ExportModal />

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
