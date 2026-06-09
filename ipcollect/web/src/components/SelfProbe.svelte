<script>
  // 首页「你的接入」自助探测 —— 多出口卡片(单一 DOM, 真·层叠)。
  // 请求一批开放 CORS 的边缘端点(geo.probeEgressIps: cdn-cgi/trace + upyun), 取各端点看到的
  // 客户端 IP, 去重后按 family 分两叠(左 v4 / 右 v6); 有几个出口 IP 就有几张(每族最多 4)。
  //
  // 关键: 所有卡片是同一批持久 DOM 元素, 从不重新生成。两种布局(叠 / 摊)都由 styleFor() 算出
  // 每张卡的 transform(绝对定位 + 居中 left:50%), 靠 CSS transition 在两态间平滑过渡 ——
  //   · 叠(collapsed): 每族 N 张真叠在一起(第 2 张后透明), 点叠 = 切下一张; 第一张带 [+N IP] 角标。
  //   · 摊(expanded): 同一批卡飞向网格(一行≤4), v4/v6 同时发; 收回即逆过程, 同一批元素飞回叠。
  // family 由右下角 IPv4/IPv6 色标(family 背景色)标识。富集(probeIp)只改卡内文案, 不动元素。
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { probeEgressIps } from '../lib/geo.js'
  import { probeIp } from '../lib/queries.js'
  import { holderOrg } from '../lib/rdap.js'
  import { iVisible, iLowvis, iLoc } from '../lib/icons.js'
  import { iChevD } from '../lib/icons.js'

  let { onpick = () => {} } = $props()

  // 几何常量(桌面; 窄屏整块隐藏)。卡宽=叠卡宽=摊卡宽(纯位移, 不缩放→不闪)。
  const CARDW = 300, CARDH = 150, GAP = 16, PILEGAP = 40

  // 隐藏 IP(截图/隐私): 仅遮挡出口地址, 富集照常。v4/v6 各自独立, 记忆于 localStorage("v4,v6" 两位)。
  const HIDE_KEY = 'ipc-hide-self-ip'
  let hide = $state((() => {
    try { const s = (localStorage.getItem(HIDE_KEY) || '').split(','); return [s[0] === '1', s[1] === '1'] }
    catch (e) { return [false, false] }
  })())
  function toggleHide(fi) {
    hide[fi] = !hide[fi]
    try { localStorage.setItem(HIDE_KEY, (hide[0] ? '1' : '0') + ',' + (hide[1] ? '1' : '0')) } catch (e) { /* 隐私模式忽略 */ }
  }

  let probing = $state(true)
  let defaultIp = $state(null)            // 被最多端点看到的出口(浏览器主用栈)
  let fams = $state([
    { fam: 'ip4', label: 'IPv4', accent: '#2563eb', entries: [], front: 0 },   // 蓝
    { fam: 'ip6', label: 'IPv6', accent: '#9333ea', entries: [], front: 0 },   // 紫
  ])

  onMount(async () => {
    const r = await probeEgressIps()
    probing = false
    defaultIp = r.defaultIp
    const fill = (fi, ips) => {
      const es = (ips || []).slice(0, 4).map(ip => ({ ip, enriching: true, info: null, holder: '' }))
      fams[fi].entries = es
      fams[fi].front = 0
      es.forEach((e, ei) => {
        probeIp(e.ip).then((info) => {
          fams[fi].entries[ei].info = info; fams[fi].entries[ei].enriching = false
          // IP 所属组织(RDAP, 异步独立填充, 失败静默): 与 origin ASN(运营商)不同
          const px = info && info.prefix
          if (px) holderOrg(px).then(h => { if (h) fams[fi].entries[ei].holder = h })
        }).catch(() => { fams[fi].entries[ei].enriching = false })
      })
    }
    fill(0, r.v4)
    fill(1, r.v6)
  })

  const stop = (e) => e.stopPropagation()
  // 隐藏态: 把每个十六进制位换成 'x'(保留 . : / 分隔符与位数), 真实 IP 不进 DOM, 截图/取证也无法还原。
  const maskIp = (ip) => String(ip).replace(/[0-9a-fA-F]/g, 'x')

  // ── 摊开态 + 布局 ───────────────────────────────────────────────
  let expanded = $derived(S.probeExpanded)
  // 活跃(浏览器主用)协议栈 = 默认出口所属 family; 其 family 色标用淡橙, 其余灰。
  let activeFam = $derived(defaultIp ? (defaultIp.includes(':') ? 'ip6' : 'ip4') : null)
  let secEl = $state()
  let stageW = $state(820)
  function toggleExpand() { S.probeExpanded = !S.probeExpanded }

  let renderList = $derived.by(() => {
    const out = []; let g = 0
    fams.forEach((f, fi) => {
      const base = { fi, fam: f.fam, accent: f.accent, label: f.label }
      if (probing) { out.push({ ...base, key: f.fam + ':skel', kind: 'skel', ci: 0, e: null, g: -1 }); return }
      if (!f.entries.length) { out.push({ ...base, key: f.fam + ':none', kind: 'none', ci: 0, e: null, g: -1 }); return }
      f.entries.forEach((e, ci) => out.push({ ...base, key: f.fam + ':' + e.ip, kind: 'ip', ci, e, g: g++ }))
    })
    return out
  })
  let entryCount = $derived(renderList.filter(c => c.kind === 'ip').length)
  let cols = $derived(Math.max(1, Math.min(4, entryCount || 1, Math.floor((stageW + GAP) / (CARDW + GAP)) || 1)))
  let gridRows = $derived(Math.max(1, Math.ceil((entryCount || 1) / cols)))
  let stageH = $derived(expanded ? gridRows * (CARDH + GAP) - GAP : CARDH + 16)

  const depthOf = (c) => {
    if (c.kind !== 'ip') return 0
    const n = fams[c.fi].entries.length || 1
    return (c.ci - fams[c.fi].front + n) % n
  }

  function styleFor(c) {
    const pileOffset = (c.fi - 0.5) * (CARDW + PILEGAP)
    if (expanded && c.kind === 'ip') {
      const row = Math.floor(c.g / cols), col = c.g % cols
      const rowCount = Math.min(cols, entryCount - row * cols)
      const offX = (col - (rowCount - 1) / 2) * (CARDW + GAP)
      const y = row * (CARDH + GAP)
      const z = 30 - depthOf(c)
      return `transform: translate(${(offX - CARDW / 2).toFixed(1)}px, ${y}px) scale(1) rotate(0deg); opacity:1; z-index:${z}; pointer-events:auto;`
    }
    if (expanded) {
      return `transform: translate(${(pileOffset - CARDW / 2).toFixed(1)}px, 0px) scale(.96) rotate(0deg); opacity:0; z-index:0; pointer-events:none;`
    }
    const d = depthOf(c)
    let dx = 0, dy = 0, sc = 1, rot = 0, op = 1
    if (d === 1) { dx = 7; dy = 11; sc = 0.94; rot = 2.4; op = 0.82 }
    else if (d >= 2) { dx = 7; dy = 11; sc = 0.94; rot = 2.4; op = 0 }
    const z = 30 - d, pe = d <= 1 ? 'auto' : 'none'
    return `transform: translate(${(pileOffset - CARDW / 2 + dx).toFixed(1)}px, ${dy}px) scale(${sc}) rotate(${rot}deg); opacity:${op}; z-index:${z}; pointer-events:${pe};`
  }
  const delayMs = (c) => (c.kind === 'ip' ? c.ci : 0) * 70

  $effect(() => {
    if (expanded && secEl) requestAnimationFrame(() => secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  })
</script>

<!-- origin: ASxxxx + AS 名称 badge -->
{#snippet asn(info)}
  <button class="lk asn" onclick={(ev) => { stop(ev); onpick('AS' + info.origin_asn) }} title={'AS' + info.origin_asn + (info.origin_name ? ' · ' + info.origin_name : '')}>
    <span class="asnum">AS{info.origin_asn}</span>
    {#if info.origin_name}<span class="asname">{info.origin_name}</span>{/if}
  </button>
{/snippet}

<!-- 一张出口卡正文: (折叠态)隐藏钮 + IP(可下钻, 可带 [+N IP]) + 库内富集(前缀 / ASxxxx+名 / 地理) -->
{#snippet body(fi, e, showBadge)}
  <div class="cbody">
    {#if !expanded}
      <button class="fold" class:folded={hide[fi]} onclick={(ev) => { stop(ev); toggleHide(fi) }}
              title={hide[fi] ? t('sp_show') : t('sp_hide')} aria-pressed={hide[fi]}>
        <Fa icon={hide[fi] ? iLowvis : iVisible} />
      </button>
    {/if}
    <div class="iprow">
      {#if hide[fi]}
        <span class="ip masked">{maskIp(e.ip)}</span>
      {:else}
        <button class="ip" onclick={(ev) => { stop(ev); onpick(e.ip) }} title={e.ip}>{e.ip}</button>
      {/if}
      {#if showBadge}<span class="ipmore">+{fams[fi].entries.length - 1} IP</span>{/if}
    </div>
    {#if e.enriching}
      <span class="sub muted">{t('sp_analyzing')}</span>
    {:else if !e.info || e.info.prefix == null}
      {#if e.info && e.info.origin_asn != null}
        <div class="kv">{@render asn(e.info)}</div>
      {:else}
        <span class="sub muted">{t('sp_nocover')}</span>
      {/if}
    {:else}
      {#if e.info.origin_asn != null}
        <div class="kv">{@render asn(e.info)}</div>
      {/if}
      {#if e.holder}
        <div class="kv"><span class="k">{t('sp_holder')}</span><span class="holder">{e.holder}</span></div>
      {/if}
      {#if e.info.loc}
        <div class="loc"><Fa icon={iLoc} /><span>{e.info.loc}</span></div>
      {/if}
    {/if}
  </div>
{/snippet}

<section class="sp" class:expanded bind:this={secEl}>
  <div class="stage" bind:clientWidth={stageW} style="height:{stageH}px">
    {#each renderList as c (c.key)}
      {@const d = depthOf(c)}
      <div class="card" class:clickable={!expanded && c.kind === 'ip'}
           data-t={c.fam} style="--ac:{c.accent}; transition-delay:{delayMs(c)}ms; {styleFor(c)}"
           role={!expanded && c.kind === 'ip' ? 'button' : undefined}
           onclick={() => { if (!expanded && c.kind === 'ip') S.probeExpanded = true }}>
        {#if c.kind === 'skel'}
          <div class="cbody"><span class="ip skel">····· ·····</span></div>
        {:else if c.kind === 'none'}
          <div class="cbody"><span class="none">{c.fam === 'ip4' ? t('sp_v4none') : t('sp_v6none')}</span></div>
        {:else}
          {@render body(c.fi, c.e, !expanded && d === 0 && fams[c.fi].entries.length > 1)}
        {/if}
        {#if expanded || d === 0}<span class="famtag" class:act={c.fam === activeFam}>{c.label}</span>{/if}
      </div>
    {/each}
  </div>

  {#if !probing && expanded && entryCount > 0}
    <div class="dealrow">
      <button class="dealbtn up" onclick={toggleExpand}
              title={t('sp_collapse')} aria-label={t('sp_collapse')}>
        <Fa icon={iChevD} />
      </button>
    </div>
  {/if}
</section>

<style>
  .sp { margin: 30px 0 0; padding: 6px 26px 18px; }

  .stage { position: relative; width: 100%; transition: height .55s cubic-bezier(.2, .8, .25, 1); }

  .card {
    position: absolute; top: 0; left: 50%; width: 300px; height: 150px;
    display: flex; flex-direction: column; overflow: hidden; border-radius: 16px;
    background: linear-gradient(180deg, var(--panel), color-mix(in srgb, var(--panel) 84%, var(--bg)));
    border: 1px solid var(--line); transform-origin: 50% 50%; will-change: transform, opacity;
    box-shadow: 0 16px 34px -22px rgba(0,0,0,.5);
    transition: transform .55s cubic-bezier(.2, .8, .25, 1), opacity .45s ease;
  }
  .card.clickable { cursor: pointer; }
  .sp.expanded .card { cursor: default; }

  /* 右下角 family 色标(IPv4/IPv6, 仅第一张): 非活跃栈=灰; 活跃(浏览器主用)栈=淡橙(低对比度) */
  .famtag {
    position: absolute; right: 0; bottom: 0; z-index: 6; pointer-events: none;
    padding: 5px 10px; border-radius: 9px 0 0 0;
    font: 800 9px var(--sans); letter-spacing: .14em; text-transform: uppercase; line-height: 1;
    color: var(--muted); background: color-mix(in srgb, var(--muted) 12%, transparent);
  }
  .famtag.act { color: #cf9f63; background: color-mix(in srgb, #cf9f63 15%, transparent); }

  .cbody { flex: 1; min-height: 0; padding: 15px 17px 16px; display: flex; flex-direction: column; gap: 9px; }

  .fold {
    position: absolute; top: 0; right: 0; z-index: 7;
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; cursor: pointer; border: 0;
    border-radius: 0 0 0 9px; background: transparent; color: var(--muted);
    transition: box-shadow .32s cubic-bezier(.34, 1.56, .64, 1), color .15s, background .2s;
  }
  .fold:hover { color: var(--fg); }
  .fold :global(svg) { width: 12px; height: 12px; }
  .fold.folded { background: color-mix(in srgb, var(--ac) 9%, transparent); box-shadow: inset 2px -2px 4px -1px rgba(0,0,0,.2); }

  /* IP 行: flex 居中对齐, [+N IP] 角标与 IP 垂直对齐 */
  .iprow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-right: 30px; line-height: 1.3; }
  .ip { font: 600 15px var(--mono); text-align: left; color: var(--fg); letter-spacing: -.01em; background: none; border: 0; padding: 0; cursor: pointer; word-break: break-all; }
  button.ip:hover { color: var(--ac); }
  .ip.skel { color: var(--muted); opacity: .45; letter-spacing: .22em; cursor: default; }
  .ip.masked { user-select: none; cursor: default; color: var(--muted); opacity: .7; letter-spacing: .03em; }
  .none { font: 500 13px var(--sans); color: var(--muted); }
  .sub { font-size: 12.5px; }
  .muted { color: var(--muted); font-family: var(--sans); }

  .ipmore {
    flex: 0 0 auto; font: 700 10px var(--sans); letter-spacing: .03em; line-height: 1;
    color: var(--ac); background: color-mix(in srgb, var(--ac) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--ac) 34%, transparent); border-radius: 999px; padding: 3px 7px; white-space: nowrap;
  }

  .kv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .k { font: 700 9px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .lk { background: none; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 500 13.5px var(--sans); text-align: left; }
  .lk.mono { font-family: var(--mono); font-size: 13.5px; word-break: break-all; }
  .holder { font: 500 12.5px var(--sans); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .lk:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* origin: ASxxxx + 名称 badge */
  .asn { text-decoration: none!important; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .asnum { font: 600 13.5px var(--mono); color: var(--link); }
  .asname {
    font: 600 10.5px var(--sans); color: var(--muted); line-height: 1;
    background: var(--alt); border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px;
    max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .asn:hover .asnum { text-decoration: underline; text-underline-offset: 3px; }

  .loc { display: inline-flex; align-items: center; gap: 6px; margin-top: auto; padding-right: 56px; font: 500 12px var(--sans); color: var(--muted); }
  .loc :global(svg) { width: 11px; opacity: .85; }
  .loc span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dealrow { display: flex; justify-content: center; margin-top: 14px; }
  .dealbtn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 46px; height: 28px; padding: 0; border-radius: 999px; cursor: pointer;
    background: var(--inbg); border: 1px solid var(--line); color: var(--muted);
    box-shadow: 0 10px 24px -18px rgba(0,0,0,.6);
    transition: color .15s, border-color .15s, background .15s, transform .15s;
  }
  .dealbtn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); transform: translateY(1px); }
  .dealbtn.up:hover { transform: translateY(-1px); }
  .dealbtn :global(svg) { width: 14px; transition: transform .45s cubic-bezier(.16,1,.3,1); }
  .dealbtn.up :global(svg) { transform: rotate(180deg); }

  @media (max-width: 820px) {
    .sp { padding: 6px 16px 16px; }
    .ip { font-size: 16px; }
  }
</style>
