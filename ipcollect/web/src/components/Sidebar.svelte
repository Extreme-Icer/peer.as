<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { cycleTheme, toggleLang } from '../lib/ui.js'
  import { iPrefix, iPath, iGlobal, iClock, iTheme, iLang, iAbout, iRepo, iIssue, iChangelog } from '../lib/icons.js'

  let counts = $derived(S.meta?.counts || {})
  let nCountry = $derived((S.meta?.countries || []).length)
  let fmt = n => (n ?? '—') === '—' ? '—' : Number(n).toLocaleString()
  let themeLabel = $derived({ auto: 'AUTO', light: 'LIGHT', dark: 'DARK' }[S.theme] || 'AUTO')
</script>

<aside class="side">
  <div class="brand">
    <div class="logo"><span class="dot"></span>PEER<span class="hi">.AS</span></div>
  </div>

  <section class="sec">
    <h3>{t('overview')}</h3>
    <dl class="stats">
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix')}</dt><dd>{fmt(counts.prefixes)}</dd></div>
      <div><dt><Fa icon={iPath} /> {t('t_paths')}</dt><dd>{fmt(counts.paths)}</dd></div>
      <div><dt><Fa icon={iGlobal} /> {t('t_country')}</dt><dd>{nCountry || '—'}</dd></div>
      <div><dt><Fa icon={iClock} /> {t('t_gen')}</dt><dd class="gen">{S.meta?.generated_str || '—'}</dd></div>
    </dl>
  </section>

  <div class="foot">
    <nav class="links">
      <a class="lnk" href="https://github.com/Archeb/peer.as" target="_blank" rel="noopener noreferrer">
        <Fa icon={iRepo} /> {t('src_home')}
      </a>
      <a class="lnk" href="https://github.com/Archeb/peer.as/issues" target="_blank" rel="noopener noreferrer">
        <Fa icon={iIssue} /> {t('feedback')}
      </a>
      <button class="lnk lnkbtn" onclick={() => (S.changelog = true)}>
        <Fa icon={iChangelog} /> {t('changelog')}
      </button>
    </nav>
    <div class="ctl">
      <button class="ghost" onclick={toggleLang} title="中 / English">
        <Fa icon={iLang} /> {S.lang === 'zh' ? 'EN' : '中'}
      </button>
      <button class="ghost" onclick={cycleTheme} title={t('theme')}>
        <Fa icon={iTheme} /> {themeLabel}
      </button>
      <button class="ghost" onclick={() => (S.about = true)} title={t('about')}>
        <Fa icon={iAbout} />
      </button>
    </div>
  </div>
</aside>

<style>
  .side {
    flex: 0 0 218px; width: 218px; color: #aeb9c9;
    background:
      radial-gradient(rgba(255,255,255,.022) 1px, transparent 1px) 0 0 / 15px 15px,
      linear-gradient(180deg, #0a0e15, #070a0f);
    display: flex; flex-direction: column; gap: 20px; padding: 18px 16px 14px;
    position: sticky; top: 0; height: 100vh; overflow: auto;
    border-right: 1px solid #182234;
  }
  .brand .logo {
    font: 800 18px/1 var(--mono); letter-spacing: -.01em; color: #f3f6fa;
    display: flex; align-items: center;
  }
  .brand .logo .hi { color: var(--accent); }
  .brand .logo .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
    margin-right: 9px; box-shadow: 0 0 10px var(--accent); animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .brand .tag { font-size: 10.5px; color: #5d6b80; margin-top: 7px; line-height: 1.4; }

  .sec h3 {
    margin: 0 0 9px; font: 700 10px/1 var(--sans); letter-spacing: .14em;
    text-transform: uppercase; color: #4d5a70;
  }
  .stats { margin: 0; }
  .stats > div {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 5px 0; border-bottom: 1px solid #141d2c; font-size: 12px;
  }
  .stats dt { color: #8693a6; display: inline-flex; align-items: center; gap: 7px; }
  .stats dt :global(svg) { color: #4d5a70; width: 11px; }
  .stats dd { margin: 0; color: #e9eef5; font: 600 12.5px/1 var(--mono); }
  .stats dd.gen { font-size: 11px; color: #aeb9c9; }

  .foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
  .links { display: flex; flex-direction: column; gap: 3px; border-top: 1px solid #141d2c; padding-top: 10px; }
  .lnk {
    display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
    color: #8693a6; font: 600 11px var(--sans); padding: 4px 2px; transition: color .15s;
  }
  .lnk :global(svg) { color: #4d5a70; width: 12px; transition: color .15s; }
  .lnk:hover, .lnk:hover :global(svg) { color: var(--accent); }
  .lnkbtn { background: transparent; border: 0; cursor: pointer; text-align: left; font-family: var(--sans); }
  .ctl { display: flex; gap: 6px; }
  .ctl .ghost {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: transparent; border: 1px solid #25324a; color: #aeb9c9;
    border-radius: 7px; padding: 7px 8px; font: 600 11px var(--sans); cursor: pointer;
    transition: all .15s;
  }
  .ctl .ghost:hover { background: #131c2b; color: #fff; border-color: var(--accent); }

  /* 移动端: 桌面侧栏隐藏, 改用 MobileBar(顶栏 logo + 下拉菜单) */
  @media (max-width: 820px) {
    .side { display: none; }
  }
</style>
