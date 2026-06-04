<script>
  // 移动端专用顶栏: 左=项目 logo, 右=下拉菜单(桌面侧栏的统计/链接/语言/主题/关于/更新日志)。
  // 仅在窄屏显示(CSS @media); 桌面侧栏在窄屏隐藏。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { cycleTheme, toggleLang } from '../lib/ui.js'
  import { setView, goHome } from '../lib/queries.js'
  import { iMenu, iClose, iPrefix, iPath, iGlobal, iClock, iTheme, iLang, iAbout, iRepo, iIssue, iChangelog, iNet, iWhois } from '../lib/icons.js'
  import { brand, features } from '../lib/site.js'

  let counts = $derived(S.meta?.counts || {})
  let nCountry = $derived((S.meta?.countries || []).length)
  let fmt = n => (n ?? '—') === '—' ? '—' : Number(n).toLocaleString()
  let themeLabel = $derived({ auto: 'AUTO', light: 'LIGHT', dark: 'DARK' }[S.theme] || 'AUTO')
  const close = () => (S.menu = false)
  const openModal = k => { S.menu = false; S[k] = true }
</script>

<header class="mbar">
  <button class="logo" onclick={() => { S.menu = false; goHome() }} aria-label={t('home')}><span class="dot"></span>{brand.main}<span class="hi">{brand.hi}</span></button>
  <button class="menubtn" onclick={() => (S.menu = !S.menu)} aria-label={t('menu')} aria-expanded={S.menu}>
    <Fa icon={S.menu ? iClose : iMenu} />
  </button>
</header>

{#if S.menu}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div class="menu" role="menu">
    {#if features.whoisView}
      <nav class="vnav" aria-label={t('nav_views')}>
        <button class="vitem" class:on={S.view === 'whois'} onclick={() => { close(); setView('whois') }}>
          <Fa icon={iWhois} /> {t('nav_whois')}
        </button>
        <button class="vitem" class:on={S.view === 'routing'} onclick={() => { close(); setView('routing') }}>
          <Fa icon={iNet} /> {t('nav_routing')}
        </button>
      </nav>
    {/if}
    <dl class="stats">
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix4')}</dt><dd>{fmt(counts.prefixes)}</dd></div>
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix6')}</dt><dd>{fmt(counts.prefixes_v6)}</dd></div>
      <div><dt><Fa icon={iPath} /> {t('t_paths')}</dt><dd>{fmt((counts.paths || 0) + (counts.paths_v6 || 0))}</dd></div>
      <div><dt><Fa icon={iGlobal} /> {t('t_country')}</dt><dd>{nCountry || '—'}</dd></div>
      <div><dt><Fa icon={iClock} /> {t('t_gen')}</dt><dd class="gen">{S.meta?.generated_str || '—'}</dd></div>
    </dl>
    <nav class="links">
      <a class="lnk" href="https://github.com/Archeb/peer.as" target="_blank" rel="noopener noreferrer" onclick={close}>
        <Fa icon={iRepo} /> {t('src_home')}
      </a>
      <a class="lnk" href="https://github.com/Archeb/peer.as/issues" target="_blank" rel="noopener noreferrer" onclick={close}>
        <Fa icon={iIssue} /> {t('feedback')}
      </a>
      <button class="lnk" onclick={() => openModal('changelog')}><Fa icon={iChangelog} /> {t('changelog')}</button>
      <button class="lnk" onclick={() => openModal('about')}><Fa icon={iAbout} /> {t('about')}</button>
    </nav>
    <div class="ctl">
      <button class="ghost" onclick={toggleLang}><Fa icon={iLang} /> {S.lang === 'zh' ? 'EN' : '中'}</button>
      <button class="ghost" onclick={cycleTheme}><Fa icon={iTheme} /> {themeLabel}</button>
    </div>
  </div>
{/if}

<style>
  /* 默认隐藏(桌面用侧栏); 仅窄屏显示 */
  .mbar { display: none; }

  @media (max-width: 820px) {
    .mbar {
      display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 8; padding: 10px 14px;
      background: linear-gradient(180deg, #0a0e15, #070a0f); border-bottom: 1px solid #182234;
    }
    .logo { font: 800 17px/1 var(--mono); letter-spacing: -.01em; color: #f3f6fa; display: flex; align-items: center; background: none; border: 0; padding: 0; cursor: pointer; }
    .logo .hi { color: var(--accent); }
    .logo .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 9px; box-shadow: 0 0 10px var(--accent); }
    .menubtn {
      display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
      background: transparent; border: 1px solid #25324a; border-radius: 8px; color: #cfd8e6;
      font-size: 16px; cursor: pointer;
    }
    .menubtn:active { background: #131c2b; }

    .scrim { position: fixed; inset: 0; z-index: 9; background: rgba(2, 6, 14, .5); }
    .menu {
      position: fixed; top: 58px; right: 10px; left: 10px; z-index: 10;
      background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, .5); padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px; animation: drop .14s ease;
    }
    @keyframes drop { from { opacity: 0; transform: translateY(-6px); } }

    .vnav { display: flex; gap: 6px; }
    .vnav .vitem {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      background: transparent; border: 1px solid var(--line); border-radius: 8px;
      padding: 10px 8px; font: 600 12.5px var(--sans); color: var(--fg); cursor: pointer;
    }
    .vnav .vitem :global(svg) { width: 13px; color: var(--muted); }
    .vnav .vitem.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
    .vnav .vitem.on :global(svg) { color: var(--accent); }

    .stats { margin: 0; }
    .stats > div { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line2); font-size: 13px; }
    .stats dt { color: var(--muted); display: inline-flex; align-items: center; gap: 7px; }
    .stats dt :global(svg) { color: var(--muted); width: 12px; }
    .stats dd { margin: 0; color: var(--fg); font: 600 13px/1 var(--mono); }
    .stats dd.gen { font-size: 11.5px; }

    .links { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--line2); padding-top: 8px; }
    .lnk {
      display: inline-flex; align-items: center; gap: 10px; text-decoration: none;
      color: var(--fg); font: 600 13px var(--sans); padding: 9px 4px;
      background: transparent; border: 0; cursor: pointer; text-align: left; width: 100%;
    }
    .lnk :global(svg) { color: var(--muted); width: 14px; }
    .lnk:active { color: var(--accent); }
    .ctl { display: flex; gap: 8px; }
    .ctl .ghost {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      background: transparent; border: 1px solid var(--line); color: var(--fg);
      border-radius: 8px; padding: 10px 8px; font: 600 12.5px var(--sans); cursor: pointer;
    }
    .ctl .ghost:active { background: var(--alt); border-color: var(--accent); }
  }
</style>
