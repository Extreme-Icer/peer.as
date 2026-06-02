<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { ccLabel, classifyQuery } from '../lib/bgp.js'
  import { resolveCC, scheduleSearch, searchNow, openWhoisFromBox } from '../lib/queries.js'
  import { iCountry, iCity, iPath, iSubnet, iSearch, iClear, iHelp, iWhois } from '../lib/icons.js'
  import Field from './Field.svelte'

  let cc = $derived(resolveCC(S.filters.cc))
  let cities = $derived((cc && S.meta?.cities?.[cc]) || [])
  let f = S.filters
  // 精确框类型(empty/ipv4/asn/ipv6/text)：IP/CIDR 时 AS_PATH 不可叠加(prefixes 无路径数据), 其余筛选都可组合。
  let probe = $derived(classifyQuery(S.filters.ip))
  let pathNA = $derived(probe.kind === 'ipv4' || probe.kind === 'ipv6')
  let canWhois = $derived(probe.kind === 'asn')   // 移动端 Whois 按钮: 仅当精确框是 ASN 时可用
  // family 单选: 约束国家/全表搜索只看 v4 或 v6(子网搜索由 IP 本身决定 family, 此时禁用)。
  const FAM = [{ v: 'all', label: () => t('fam_all') }, { v: '4', label: () => 'IPv4' }, { v: '6', label: () => 'IPv6' }]
  let famIdx = $derived(Math.max(0, FAM.findIndex(o => o.v === (f.fam || 'all'))))
  function setFam(v) { f.fam = v; if (!pathNA) searchNow() }
  const sched = () => scheduleSearch(700)
  const noop = () => {}
  function clearAll() {
    Object.assign(f, { cc: '', city: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' })
    searchNow()
  }
</script>

<header class="topbar">
  <div class="filters">
    <!-- 第一行: family 单选 + 精确查询 IP / CIDR / ASN — 命中即抢占, 其余筛选禁用 -->
    <div class="row primary">
      <div class="famseg" class:disabled={pathNA} role="radiogroup" aria-label={t('fam_label')}>
        <span class="fampill" style="transform: translateX({famIdx * 100}%)"></span>
        {#each FAM as o}
          <button type="button" class="famopt" class:on={(f.fam || 'all') === o.v}
            role="radio" aria-checked={(f.fam || 'all') === o.v} disabled={pathNA}
            title={t('fam_label')} onclick={() => setFam(o.v)}>{o.label()}</button>
        {/each}
      </div>
      <Field icon={iSubnet} bind:value={f.ip} placeholder={t('ph_ip')} big grow width=""
        oninput={sched} onenter={searchNow} />
      <button class="gobtn big" onclick={searchNow}><Fa icon={iSearch} /> {t('search')}</button>
      <button class="gobtn big whoisbtn" onclick={openWhoisFromBox} disabled={!canWhois} title={t('whois_open')}><Fa icon={iWhois} /> WHOIS</button>
      <button class="clrbtn" onclick={clearAll} title={t('clear')}><Fa icon={iClear} /></button>
    </div>
    <!-- 第二行: 其余筛选(AS_PATH 撑满剩余宽度) -->
    <div class="row secondary">
      <Field icon={iCountry} bind:value={f.cc} placeholder={t('ph_cc')} list="cclist"
        width="220px" oninput={sched} onenter={searchNow} />
      <Field icon={iCity} bind:value={f.city} placeholder={cities.length ? t('ph_city') : '—'}
        list="citylist" disabled={!cities.length} width="155px" oninput={sched} onenter={searchNow} />
      <Field icon={iPath} bind:value={f.path} placeholder={t('ph_path')}
        grow width="" disabled={pathNA} oninput={noop} onenter={searchNow} />
      <button class="helpbtn" onclick={() => (S.pathHelp = true)} title={t('path_help')} aria-label={t('path_help')}>
        <Fa icon={iHelp} />
      </button>
      <input class="numbox" type="text" bind:value={f.limit} title={t('ph_limit')}
        oninput={sched} onkeydown={(e) => e.key === 'Enter' && searchNow()} />
      <label class="chk" title={t('lowvis')}>
        <input type="checkbox" bind:checked={f.incllow} onchange={sched} />
        <span>{t('incllow')}</span>
      </label>
      {#if pathNA}<span class="locknote">{t('path_na')}</span>{/if}
    </div>
  </div>
  <div class="statusline">{S.msg}</div>

  <datalist id="cclist">
    {#each S.meta?.countries || [] as c}
      <option value={ccLabel(c.cc)}>{c.n_prefix.toLocaleString()}{(S.meta?.focus_countries || []).includes(c.cc) ? (S.lang === 'zh' ? ' · 可到城市' : ' · city-level') : ''}</option>
    {/each}
  </datalist>
  <datalist id="citylist">
    {#each cities as c}<option value={c.name}>{c.n_prefix.toLocaleString()}</option>{/each}
  </datalist>
</header>

<style>
  .topbar {
    position: sticky; top: 0; z-index: 6; padding: 12px 18px 10px;
    background:
      radial-gradient(rgba(125,200,190,.025) 1px, transparent 1px) 0 0 / 18px 18px,
      var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .filters { display: flex; flex-direction: column; gap: 9px; }
  .row { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
  .row.primary { padding-bottom: 9px; border-bottom: 1px dashed var(--line); }
  .gobtn.big { height: 40px; padding: 0 22px; font-size: 13.5px; border-radius: 9px; }
  /* family 单选(分段控件): 3 段等宽 + 滑动高亮块, 切换时动画。 */
  .famseg {
    position: relative; flex: 0 0 auto; display: inline-flex; height: 40px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 9px;
    padding: 3px; gap: 0; user-select: none;
  }
  .famseg .fampill {
    position: absolute; top: 3px; left: 3px; bottom: 3px; width: calc((100% - 6px) / 3);
    background: var(--accent); border-radius: 7px; box-shadow: 0 2px 8px var(--accent-dim);
    transition: transform .2s cubic-bezier(.4, 0, .2, 1); will-change: transform; z-index: 0;
  }
  .famseg .famopt {
    position: relative; z-index: 1; flex: 1 0 auto; min-width: 44px; padding: 0 12px;
    background: transparent; border: 0; border-radius: 7px; cursor: pointer;
    font: 600 12px var(--sans); color: var(--muted); transition: color .2s; white-space: nowrap;
  }
  .famseg .famopt.on { color: var(--accent-fg); }
  .famseg .famopt:not(.on):hover { color: var(--fg); }
  .famseg.disabled { opacity: .45; pointer-events: none; }
  .clrbtn {
    display: inline-flex; align-items: center; justify-content: center; height: 40px; width: 40px;
    flex: 0 0 auto; background: transparent; border: 1px solid var(--line); border-radius: 9px;
    color: var(--muted); cursor: pointer; transition: all .12s;
  }
  .clrbtn:hover { color: #ef4444; border-color: #ef4444; background: color-mix(in srgb, #ef4444 8%, transparent); }
  .numbox {
    width: 64px; height: 32px; background: var(--inbg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 7px; padding: 0 9px;
    font: 12.5px var(--mono); outline: none;
  }
  .numbox:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .helpbtn {
    display: inline-flex; align-items: center; justify-content: center; height: 32px; width: 32px;
    flex: 0 0 auto; background: transparent; border: 1px solid var(--line); border-radius: 7px;
    color: var(--muted); cursor: pointer; transition: all .12s;
  }
  .helpbtn:hover { color: var(--accent); border-color: var(--accent); }
  .chk {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--muted); cursor: pointer; white-space: nowrap; user-select: none;
  }
  .chk input { width: auto; accent-color: var(--accent); }
  .gobtn {
    display: inline-flex; align-items: center; gap: 7px; height: 32px;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 7px;
    padding: 0 16px; font: 600 12.5px var(--sans); cursor: pointer; transition: filter .12s, transform .05s;
    box-shadow: 0 2px 10px var(--accent-dim);
  }
  .gobtn:hover { filter: brightness(1.08); }
  .gobtn:active { transform: translateY(1px); }
  .gobtn:disabled { opacity: .4; cursor: default; filter: none; box-shadow: none; }
  .whoisbtn { display: none; }   /* 仅移动端显示(见 @media) */
  .statusline { margin-top: 9px; min-height: 16px; font-size: 12px; color: var(--muted); }
  .numbox:disabled { opacity: .45; cursor: not-allowed; }
  .chk input:disabled ~ span { opacity: .45; }
  /* Field 组件被禁用时统一变暗(兼容根为 input 或包裹 input 两种结构) */
  .row.secondary :global(.field input:disabled),
  .row.secondary :global(input.field:disabled) { opacity: .45; cursor: not-allowed; }
  .locknote {
    display: inline-flex; align-items: center; white-space: nowrap;
    font-size: 11px; color: var(--accent); letter-spacing: .02em;
  }
  @media (max-width: 820px) {
    .topbar { padding: 10px 12px; }
    /* 次要筛选行: 两列自适应 */
    .row.secondary :global(.field) { flex: 1 1 calc(50% - 9px); width: auto !important; }
    /* 主查询行 第1行: 全部/v4/v6 分段 + 主搜索框 同行; 第2行: 搜索 + WHOIS + 清空 */
    .row.primary .famseg { flex: 0 0 auto; }
    .row.primary :global(.field) { flex: 1 1 58%; width: auto !important; }
    .row.primary .gobtn.big { flex: 1 1 auto; }
    .row.primary .whoisbtn { display: inline-flex; }
    .row.primary .clrbtn { flex: 0 0 auto; }
  }
</style>
