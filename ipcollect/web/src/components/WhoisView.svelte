<script>
  // WHOIS 独立视图(顶层 view==='whois', features.whoisView 门控)。
  // 一个「注册局卷宗」气质的全宽查询页: 命令行式输入框 -> 解析成 record 卷宗,
  // 数据正文复用现有 Whois.svelte(kind 'autnum'|'ip'|'domain')。解析/路由逻辑在 queries.runWhois。
  // 空状态时整列垂直居中; 一旦有结果(或错误)则顶部对齐(类 class:center)。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { runWhois, openInRouting } from '../lib/queries.js'
  import { features } from '../lib/site.js'
  import { iSearch, iArrowR } from '../lib/icons.js'
  import MobileBar from './MobileBar.svelte'
  import Whois from './Whois.svelte'

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

  function submit(e) { e?.preventDefault(); runWhois(box) }
  function pick(x) { box = x; runWhois(x) }
</script>

<main class="wv">
  <MobileBar />
  <div class="scroll" class:center={!S.whois.kind}>
    <div class="col">
      <form class="console" onsubmit={submit}>
        <span class="sigil">whois</span>
        <span class="prompt" aria-hidden="true">▸</span>
        <input
          bind:this={inputEl}
          class="cmd"
          bind:value={box}
          placeholder={t('wv_ph')}
          spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
          aria-label="WHOIS"
        />
        <button type="submit" class="run"><Fa icon={iSearch} /> <span>{t('wv_go')}</span></button>
      </form>

      {#if EXAMPLES.length}
        <div class="examples">
          <span class="exlabel">{t('wv_examples')}</span>
          {#each EXAMPLES as ex}
            <button class="chip" onclick={() => pick(ex)}>{ex}</button>
          {/each}
        </div>
      {/if}

      {#if S.whois.err}
        <div class="notice bad">{t(S.whois.err)}</div>
      {:else if S.whois.kind}
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
    background:
      radial-gradient(1100px 460px at 50% -180px, var(--accent-dim), transparent 70%),
      radial-gradient(rgba(125,200,190,.05) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg);
  }
  .scroll { flex: 1; overflow: auto; padding: 48px 22px 60px; }
  /* 空状态: 整列垂直居中(视觉重心居中); 有结果后回到顶部对齐(.scroll 无 .center)。 */
  .scroll.center { display: flex; flex-direction: column; justify-content: center; padding-bottom: 12vh; }
  .col { max-width: 820px; margin: 0 auto; width: 100%; }

  /* ── 命令行输入 ── */
  .console {
    display: flex; align-items: center; gap: 10px; margin-top: 6px;
    padding: 0 8px 0 16px; height: 58px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 14px 40px -22px rgba(0,0,0,.55);
    transition: border-color .15s, box-shadow .15s;
  }
  .console:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim), 0 14px 40px -22px rgba(0,0,0,.55); }
  .sigil { font: 700 14px var(--mono); color: var(--accent); letter-spacing: .02em; user-select: none; }
  .prompt { color: var(--accent); font: 700 14px var(--mono); animation: blink 1.25s step-end infinite; user-select: none; }
  @keyframes blink { 0%,55% { opacity: 1 } 56%,100% { opacity: .25 } }
  .cmd {
    flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent;
    font: 500 17px var(--mono); color: var(--fg); letter-spacing: -.005em;
  }
  .cmd::placeholder { color: var(--muted); opacity: .7; }
  .run {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 10px;
    font: 700 13.5px var(--sans); cursor: pointer; box-shadow: 0 2px 12px var(--accent-dim);
    transition: filter .12s, transform .05s;
  }
  .run:hover { filter: brightness(1.08); }
  .run:active { transform: translateY(1px); }
  .run :global(svg) { width: 13px; }

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

  /* ── 提示态 ── */
  .notice {
    margin-top: 26px; padding: 26px 22px; border-radius: 14px; text-align: center;
    font-size: 13px; line-height: 1.6; border: 1px dashed var(--line); color: var(--muted);
    background: color-mix(in srgb, var(--panel) 60%, transparent);
  }
  .notice.bad { border-style: solid; border-color: color-mix(in srgb, #ef4444 40%, transparent); color: #ef4444; background: color-mix(in srgb, #ef4444 8%, transparent); }

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
    .console { flex-wrap: wrap; height: auto; padding: 10px 12px; gap: 8px; }
    .cmd { flex: 1 1 100%; order: 2; height: 34px; font-size: 16px; }
    .sigil, .prompt { order: 1; }
    .run { order: 3; flex: 1 1 100%; justify-content: center; height: 40px; }
    /* 卷宗: 色脊转为顶部横条 */
    .dossier { flex-direction: column; }
    .spine { flex: 0 0 auto; height: 34px; width: 100%; border-right: 0; border-bottom: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 30%, transparent); }
    .spine-lbl { writing-mode: horizontal-tb; transform: none; }
    .reckey { font-size: 17px; }
  }
</style>
