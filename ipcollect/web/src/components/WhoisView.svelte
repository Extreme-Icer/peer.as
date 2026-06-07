<script>
  // WHOIS 独立视图(顶层 view==='whois', features.whoisView 门控)。
  // 一个「注册局卷宗」气质的全宽查询页: 命令行式输入框 -> 解析成 record 卷宗,
  // 数据正文复用现有 Whois.svelte(kind 'autnum'|'ip'|'domain')。解析/路由逻辑在 queries.runWhois。
  // 空状态时整列垂直居中; 一旦有结果(或错误)则顶部对齐(类 class:center)。
  import Fa from 'svelte-fa'
  import { onMount } from 'svelte'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { runWhois, openInRouting, routeTier1s, goHome } from '../lib/queries.js'
  import { features } from '../lib/site.js'
  import { regionName, asnName } from '../lib/bgp.js'
  import { fetchTrace, ccLatLon } from '../lib/geo.js'
  import { iSearch, iArrowR, iClose } from '../lib/icons.js'
  import MobileBar from './MobileBar.svelte'
  import Whois from './Whois.svelte'
  import Doodle from './Doodle.svelte'
  import SelfProbe from './SelfProbe.svelte'

  // ── 首页 3D 地球 doodle(纯装饰)──────────────────────────────────
  // 起点 = 用户连接 IP + 国家(cloudflare trace); 只画"你自己"这条连接的路由, 加载一次。
  // 之后切页面路径都不再改它(不重渲染); 出结果时整块淡出。点节点/卡片 = 快速查询。
  let dgOrigin = $state(null)
  let dgRoute = $state(null)
  let dgRouteLoading = $state(false)
  onMount(async () => {
    const tr = await fetchTrace()
    if (!tr) return
    const c = ccLatLon(tr.cc)
    dgOrigin = { ip: tr.ip, lat: c.lat, lon: c.lon, line1: tr.ip, line2: tr.cc ? regionName(tr.cc) : '' }
    dgRouteLoading = true
    try {
      const res = await routeTier1s(tr.ip)     // 你自己 IP 的路由(引擎就绪后算一次)
      if (res.origin_asn) { const nm = asnName(res.origin_asn) || ''; dgOrigin = { ...dgOrigin, asn: res.origin_asn, line2: 'AS' + res.origin_asn + (nm ? ' ' + nm : '') } }
      dgRoute = res
    } catch (e) { /* ignore */ }
    dgRouteLoading = false
  })
  let dgLoading = $derived(dgRouteLoading)

  // 背景全屏立体字 PEER.AS: 鼠标"按下"视差 + 入场淡入(bgShown) + 出结果淡出
  // 立体字整体位移(用 translate, 不用 margin): 桌面上移 150px; 移动端上移 190px
  const wordUpFor = () => (window.innerWidth <= 820 ? -190 : -150)
  let wordUp = $state(wordUpFor())
  let wordTransform = $state(`translateY(${wordUp}px)`)
  let bgShown = $state(false)
  let booting = $state(true)   // 首帧禁用过渡/动画: 直接从 URL 带查询进来时 logo/地球直接隐藏, 不放动画
  // 最近一次指针位置(client 坐标): 用于 resize 重算 wordUp 后保持视差不跳
  let lastPx = 0, lastPy = 0
  // 统一的立体字视差更新: 同时被 window mousemove 与 canvas 转发(onpointer)调用,
  // 这样指针移到 canvas 上也不会丢失跟随效果。
  function updateWord(clientX, clientY) {
    lastPx = clientX; lastPy = clientY
    const ox = Math.max(-0.5, Math.min(0.5, clientX / window.innerWidth - 0.5))
    const oy = Math.max(-0.5, Math.min(0.5, clientY / window.innerHeight - 0.5))
    wordTransform = `translateY(${wordUp}px) rotateX(${(-oy * 12).toFixed(2)}deg) rotateY(${(ox * 12).toFixed(2)}deg)`
  }
  onMount(() => {
    // 两帧后再开过渡 + 触发入场(此时若带查询, 仍是 gone 态, 不会有动画)
    requestAnimationFrame(() => requestAnimationFrame(() => { booting = false; bgShown = true }))
    const onMove = (e) => updateWord(e.clientX, e.clientY)
    const onResize = () => { wordUp = wordUpFor(); updateWord(lastPx, lastPy) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', onResize) }
  })

  // 命令行输入: 本地态, 与 S.whois.input 单向同步(外部经路由/示例改 input 时回灌, 用户键入不被打断)。
  let box = $state(S.whois.input || '')
  $effect(() => { box = S.whois.input || '' })

  let inputEl
  $effect(() => { inputEl?.focus() })

  // 已解析 record 的类型(据 S.whois.kind/key, 区分 v4/v6/CIDR), 用于卷宗色脊 + 类型徽标。
  let rec = $derived.by(() => {
    const { kind, key } = S.whois
    if (kind === 'autnum') return { cls: 'asn', label: t('wv_t_asn') }
    if (kind === 'ip') {
      const v6 = String(key).includes(':'), cidr = String(key).includes('/')
      return { cls: v6 ? 'ip6' : 'ip4', label: cidr ? t('wv_t_cidr') : (v6 ? t('wv_t_ipv6') : t('wv_t_ipv4')) }
    }
    if (kind === 'domain') return { cls: 'domain', label: t('wv_t_domain') }
    return { cls: 'none', label: t('wv_t_none') }
  })
  // 子域名提示: RDAP 站把域名缩到可注册根(key) 查询时, 告知实际查询对象。
  let rootNote = $derived(
    S.whois.kind === 'domain' && features.rdapWhois && S.whois.key &&
    S.whois.key !== (S.whois.input || '').toLowerCase().replace(/\.$/, '')
  )

  // 「查看更多信息」标签: 按对象类型给出路由分析里能提供的更深内容。
  let moreLabel = $derived.by(() => {
    const { kind, key } = S.whois
    if (kind === 'autnum') return t('wv_more_asn')
    if (kind === 'domain') return t('wv_more_domain')
    if (kind === 'ip') return String(key).includes('/') ? t('wv_more_prefix') : t('wv_more_ip')
    return ''
  })

  // peeras: 含 mozz.ie 演示 ccTLD WHOIS 兜底(无 RDAP -> 走 worker)。dn42 关此视图, 不会到这。
  const EXAMPLES = features.rdapWhois
    ? ['AS13335', '1.1.1.0/24', '2606:4700::/32', 'cloudflare.com', 'mozz.ie']
    : []

  // 「高级搜索」开 -> 任何查询直接进路由分析; 否则简洁 WHOIS(runWhois 内部仍会把 as-set/名称等非 WHOIS 对象转路由)。
  function run(x) { S.advWhois ? openInRouting(x) : runWhois(x) }
  function submit(e) { e?.preventDefault(); run(box) }
  function pick(x) { box = x; run(x) }
  // 清除: 清空输入并回到 WHOIS 首页(结果收起 + 地球淡入丝滑返回)
  function clearBox() { box = ''; goHome(); inputEl?.focus() }
  function persistAdv() { try { localStorage.setItem('ipc-adv-whois', S.advWhois ? '1' : '0') } catch (e) { /* 隐私模式忽略 */ } }
</script>

<main class="wv">
  <!-- 全屏背景 3D 立体字: 整个 view 大小, 在内容(.scroll)之后; 入场淡入, 出结果淡出 -->
  <div class="bgword" class:in={bgShown} class:gone={S.whois.kind} class:booting aria-hidden="true"><div class="word" style:transform={wordTransform}><span class="p">PEER.</span><span class="a">AS</span></div></div>
  <MobileBar />
  <div class="scroll" class:center={!S.whois.kind}>
    <div class="col">
      <div class="hero" class:gone={S.whois.kind} class:booting>
        <div class="heroinner">
          <Doodle origin={dgOrigin} route={dgRoute} loading={dgLoading} onpick={(qq) => pick(qq)} onpointer={updateWord} />
        </div>
      </div>

      <form class="console" onsubmit={submit}>
        <span class="prompt" aria-hidden="true">▸</span>
        <input
          bind:this={inputEl}
          class="cmd"
          bind:value={box}
          placeholder={t('wv_ph')}
          spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
          aria-label="WHOIS"
        />
        {#if box}
          <button type="button" class="clear" onclick={clearBox} aria-label="清除" title="清除"><Fa icon={iClose} /></button>
        {/if}
        <button type="submit" class="run"><Fa icon={iSearch} /> <span>{t('wv_go')}</span></button>
      </form>

      {#if EXAMPLES.length}
        <div class="examples">
          <span class="exlabel">{t('wv_examples')}</span>
          {#each EXAMPLES as ex}
            <button class="chip" onclick={() => pick(ex)}>{ex}</button>
          {/each}
          <label class="adv" class:on={S.advWhois} title={t('wv_adv_hint')}>
            <input type="checkbox" bind:checked={S.advWhois} onchange={persistAdv} />
            <span class="adv-sw" aria-hidden="true"><span class="adv-knob"></span></span>
            <span class="adv-txt">{t('wv_adv')}</span>
          </label>
        </div>
      {/if}

      <!-- 「你的接入」自助探测卡片: 仅首页(出结果时随 hero 一并收起) -->
      <div class="spwrap" class:gone={S.whois.kind} class:booting>
        <SelfProbe onpick={(qq) => pick(qq)} />
      </div>

      {#if S.whois.kind}
        <section class="dossier" data-t={rec.cls}>
          <div class="spine"><span class="spine-lbl">{rec.label}</span></div>
          <div class="doc">
            <div class="dochead">
              <span class="reckey">{S.whois.input}</span>
              <span class="tbadge" data-t={rec.cls}>{rec.label}</span>
            </div>
            {#if rootNote}
              <div class="subnote">{t('wv_root_note')} <b>{S.whois.key}</b></div>
            {/if}
            <Whois kind={S.whois.kind} rkey={S.whois.key} />
            {#if moreLabel}
              <button class="more" onclick={() => openInRouting(S.whois.input)}>
                <span>{moreLabel}</span> <Fa icon={iArrowR} />
              </button>
            {/if}
          </div>
        </section>
      {/if}
    </div>
  </div>
</main>

<style>
  /* 视图配色: 暗色为运营商终端, 亮色为干净变体(沿用全局 token)。背景= 点阵网格 + 顶部 accent 辉光。 */
  .wv {
    flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 100vh;
    position: relative; overflow: hidden;            /* bgword 定位上下文 + 裁到 view 内 */
    background:
      radial-gradient(1100px 460px at 50% -180px, var(--accent-dim), transparent 70%),
      radial-gradient(rgba(125,200,190,.05) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg);
  }
  /* 用 padding-top 近似居中(可过渡), 不用 justify-content(切换不可动画 → 搜索框瞬移) */
  .scroll {
    position: relative; z-index: 1; flex: 1; overflow: auto; padding: 48px 22px 60px;
    transition: padding-top .5s ease, padding-bottom .5s ease;
  }
  .scroll.center { padding-top: 4vh; padding-bottom: 12vh; }
  .col { max-width: 820px; margin: 0 auto; width: 100%; }

  /* ── 全屏背景 3D 立体字 PEER.AS ── 整个 view 大小, 不被裁剪; 入场淡入 / 出结果淡出 / 鼠标视差 ── */
  .bgword {
    /* 固定 100vh 高(不随内容/折叠改变 → 字不跳); 整个 view 宽 */
    position: absolute; top: 0; left: 0; right: 0; height: 100vh; z-index: 0; pointer-events: none;
    display: flex; flex-direction: column; align-items: center; justify-content: center; perspective: 900px;
    opacity: 0; transition: opacity .8s ease;
    /* 浅色默认; 暗色在下方覆盖 */
    --w1: #97a8b9; --w1e: #7e90a2; --w2: #cf9f63; --w2e: #b58a55;
  }
  .bgword.in { opacity: 1; }                /* 入场淡入 */
  .bgword.gone { opacity: 0; transition: opacity .45s ease; }   /* 出结果淡出(覆盖 .in) */
  .bgword.booting { transition: none; }     /* 首帧不放动画(URL 直达带查询时直接隐藏) */
  .bgword .word {
    font: 800 clamp(72px, 15vw, 300px)/1 var(--sans);
    letter-spacing: -.045em; white-space: nowrap;
    transform-style: preserve-3d; opacity: .6; user-select: none; will-change: transform;
    transition: transform .3s ease;                  /* 视差平滑(位移在 transform 内) */
  }
  .bgword span {
    text-shadow:
      1px 1px 0 var(--ext), 2px 2px 0 var(--ext), 3px 3px 0 var(--ext), 4px 4px 0 var(--ext),
      8px 12px 22px rgba(0,0,0,.22);
  }
  .bgword .p { color: var(--w1); --ext: var(--w1e); }
  .bgword .a { color: var(--w2); --ext: var(--w2e); }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .bgword { --w1: #6a85a3; --w1e: #26333f; --w2: #d0a464; --w2e: #4d3a23; }
  }
  :global(:root[data-theme='dark']) .bgword { --w1: #6a85a3; --w1e: #26333f; --w2: #d0a464; --w2e: #4d3a23; }

  /* 3D 地球 doodle hero: 装饰; 出结果淡出再收起(进入则先展开再淡入), 不卡顿/不直接消失 */
  /* 收起靠 .hero 的 height 折叠(把搜索框上移); overflow:hidden 把内层裁掉 ——
     这样下沉/位移都不会撑出 .scroll 的滚动区(否则滚动条忽隐忽现, 整列横向抖 ~2px)。
     .heroinner 固定高度(canvas 不缩放→不卡), 出结果时向下沉 + 淡出, 被收起的"地板"裁掉,
     形成"没入"效果; 回首页则从下方升起 + 淡入。 */
  .hero {
    width: 100%; height: clamp(320px, 44vw, 420px); margin: 0 auto 0px; overflow: hidden;
    transition: height .55s ease, margin-bottom .55s ease;
  }
  .hero.gone { height: 0; margin-bottom: 0; pointer-events: none; }
  .hero.booting { transition: none; }       /* 首帧不放动画 */
  .heroinner {
    height: clamp(320px, 44vw, 420px); width: 100%; opacity: 1;
    transition: transform .55s ease, opacity .55s ease;
  }
  .hero.gone .heroinner { transform: translateY(70px); opacity: 0; }   /* 向下沉没入 + 淡出 */
  .hero.booting .heroinner { transition: none; }
  @media (max-width: 820px) {
    .hero { height: clamp(200px, 56vw, 280px); }
    .heroinner { height: clamp(200px, 56vw, 280px); }
  }

  /* 「你的接入」探测卡片包裹层: 出结果时与 hero 同步收起(高度折叠 + 下沉淡出, 不直接消失) */
  .spwrap {
    overflow: hidden; max-height: 360px; opacity: 1;
    transition: max-height .5s ease, opacity .4s ease, transform .5s ease, margin .5s ease;
  }
  .spwrap.gone { max-height: 0; opacity: 0; transform: translateY(16px); margin: 0; pointer-events: none; }
  .spwrap.booting { transition: none; }

  /* ── 命令行输入 ── */
  .console {
    display: flex; align-items: center; gap: 10px; margin-top: 6px;
    padding: 0 8px 0 16px; height: 58px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 14px 40px -22px rgba(0,0,0,.55);
    transition: border-color .15s, box-shadow .15s;
  }
  .console:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim), 0 14px 40px -22px rgba(0,0,0,.55); }
  .prompt { color: var(--accent); font: 700 16px var(--mono); animation: blink 1.25s step-end infinite; user-select: none; }
  @keyframes blink { 0%,55% { opacity: 1 } 56%,100% { opacity: .25 } }
  .cmd {
    flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent;
    font: 500 17px var(--mono); color: var(--fg); letter-spacing: -.005em;
  }
  /* 占位符是中文(输入提示), 用 sans —— mono 下中文难看; 实际输入(ASN/IP/域名)仍走上面的 mono。 */
  .cmd::placeholder { color: var(--muted); opacity: .7; font-family: var(--sans); font-size: 14px; }
  .run {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 10px;
    font: 700 13.5px var(--sans); cursor: pointer; box-shadow: 0 2px 12px var(--accent-dim);
    transition: filter .12s, transform .05s;
  }
  .run:hover { filter: brightness(1.08); }
  .run:active { transform: translateY(1px); }
  .run :global(svg) { width: 13px; }

  /* 清除按钮(输入框有文字时显示, 在查询按钮左侧) */
  .clear {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; border-radius: 9px; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid transparent;
    transition: color .12s, background .12s, border-color .12s;
  }
  .clear:hover { color: var(--fg); background: var(--alt); border-color: var(--line); }
  .clear :global(svg) { width: 13px; }

  /* ── 类型徽标(按 data-t 着色) ── 用 sans: 中文(前缀/域名)在 mono 下难看 ── */
  .tbadge {
    flex: 0 0 auto; font: 700 11px var(--sans); letter-spacing: .06em; text-transform: uppercase;
    padding: 4px 9px; border-radius: 7px; white-space: nowrap;
    color: var(--tc, var(--muted));
    background: color-mix(in srgb, var(--tc, var(--muted)) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--tc, var(--muted)) 32%, transparent);
  }
  [data-t='asn']    { --tc: var(--accent); }
  [data-t='ip4']    { --tc: #3b82f6; }
  [data-t='ip6']    { --tc: #8b5cf6; }
  [data-t='cidr']   { --tc: #0ea5e9; }
  [data-t='domain'] { --tc: var(--signal); }
  [data-t='bad']    { --tc: #ef4444; }
  [data-t='none']   { --tc: var(--muted); }

  /* ── 示例 chip ── */
  .examples { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 2px 0; }
  .exlabel { font: 600 11px var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-right: 2px; }
  .chip {
    font: 500 12.5px var(--mono); color: var(--link); background: var(--inbg);
    border: 1px solid var(--line); border-radius: 8px; padding: 5px 11px; cursor: pointer;
    transition: all .13s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  /* 「高级搜索」开关: 推到示例行最右; 迷你 switch + 文字, 勾上时 accent。状态记忆于 localStorage。 */
  .adv {
    margin-left: auto; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
    padding: 4px 10px 4px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--inbg);
    transition: border-color .15s, background .15s;
  }
  .adv:hover { border-color: var(--accent); }
  .adv.on { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-dim); }
  .adv input { position: absolute; opacity: 0; width: 0; height: 0; }
  .adv-sw {
    position: relative; flex: 0 0 auto; width: 28px; height: 16px; border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 45%, transparent); transition: background .18s;
  }
  .adv-knob {
    position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--panel); box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: transform .18s;
  }
  .adv.on .adv-sw { background: var(--accent); }
  .adv.on .adv-knob { transform: translateX(12px); background: var(--accent-fg); }
  .adv input:focus-visible + .adv-sw { box-shadow: 0 0 0 3px var(--accent-dim); }
  .adv-txt { font: 600 12px var(--sans); color: var(--muted); white-space: nowrap; transition: color .15s; }
  .adv.on .adv-txt { color: var(--accent); }

  /* ── record 卷宗 ── */
  .dossier {
    position: relative; margin-top: 26px; display: flex; align-items: stretch;
    background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 60px -34px rgba(0,0,0,.6);
  }
  /* 蓝图式四角刻线 */
  .dossier::before, .dossier::after {
    content: ''; position: absolute; width: 14px; height: 14px; pointer-events: none;
    border-color: color-mix(in srgb, var(--tc, var(--accent)) 55%, transparent); opacity: .7;
  }
  .dossier::before { top: 9px; right: 9px; border-top: 2px solid; border-right: 2px solid; border-radius: 0 5px 0 0; }
  .dossier::after { bottom: 9px; right: 9px; border-bottom: 2px solid; border-right: 2px solid; border-radius: 0 0 5px 0; }
  /* 左侧色脊: 类型色竖条 + 竖排标签 */
  .spine {
    flex: 0 0 46px; display: flex; align-items: center; justify-content: center;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tc, var(--accent)) 22%, transparent), color-mix(in srgb, var(--tc, var(--accent)) 8%, transparent));
    border-right: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 30%, transparent);
  }
  /* 竖排标签: 不旋转(rotate(180) 会上下颠倒); 用 sans(中文不走 mono); 竖排上下行距用 .14em */
  .spine-lbl {
    writing-mode: vertical-rl; text-orientation: mixed;
    font: 700 11px var(--sans); letter-spacing: .14em; text-transform: uppercase;
    color: var(--tc, var(--accent));
  }
  .doc { flex: 1; min-width: 0; padding: 20px 22px 22px; }
  .dochead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .reckey { font: 700 20px var(--mono); letter-spacing: -.01em; color: var(--fg); word-break: break-all; }
  .subnote { margin: 8px 0 2px; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .subnote b { color: var(--link); font-family: var(--mono); font-weight: 600; word-break: break-all; }

  /* 「查看更多信息」: 跳到路由分析的完整详情(ASN 邻居/关系、前缀 RPKI/IRR、域名 DNS)。 */
  .more {
    display: inline-flex; align-items: center; gap: 8px; margin-top: 18px;
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); border-radius: 9px;
    padding: 9px 14px; font: 600 12.5px var(--sans); cursor: pointer; transition: all .14s; text-align: left;
  }
  .more:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .more :global(svg) { width: 12px; transition: transform .14s; }
  .more:hover :global(svg) { transform: translateX(3px); }

  @media (max-width: 820px) {
    .scroll { padding: 22px 12px 48px; }
    .console { flex-wrap: wrap; height: auto; padding: 10px 12px; gap: 8px 10px; }
    .prompt { order: 1; }
    .cmd { order: 2; flex: 1 1 auto; min-width: 0; height: 34px; font-size: 16px; }  /* 与 ▸ 同行, 填满本行剩余宽度 */
    .clear { order: 2; }                                                              /* 与 ▸/输入同行, 在其右 */
    .run { order: 3; flex: 1 1 100%; justify-content: center; height: 40px; }          /* 整行换到下一行 */
    /* 卷宗: 色脊转为顶部横条 */
    .dossier { flex-direction: column; }
    .spine { flex: 0 0 auto; height: 34px; width: 100%; border-right: 0; border-bottom: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 30%, transparent); }
    .spine-lbl { writing-mode: horizontal-tb; transform: none; }
    .reckey { font-size: 17px; }
  }
</style>
