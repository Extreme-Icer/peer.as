<script>
  // 首页「你的接入」自助探测 —— 卡片堆(card-stack)形态。
  // 左 v4 / 右 v6 各一叠 3D 层叠卡片(后方卡片缩小/旋转/偏移/渐隐), 点卡片或翻页钮逐张翻看:
  //   ① 接入出口(IP + 覆盖前缀 + origin) ② 观测上游 ③ 该前缀全部去重路径。
  // 数据: geo.probeSelfIps(test-ipv6.com 三端点 JSONP 双栈探测) + queries.probeIp(库内富集, 含 paths)。
  // 纯展示 + 可点击下钻(onpick)。探测/富集失败静默退化, 不阻塞首页。
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { probeSelfIps } from '../lib/geo.js'
  import { probeIp } from '../lib/queries.js'
  import { iVisible, iLowvis, iLoc } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'
  import AsPath from './AsPath.svelte'

  let { onpick = () => {} } = $props()

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
  let ds = $state(null)
  let fams = $state([
    { fam: 'ip4', label: 'IPv4', accent: '#2563eb', ip: null, enriching: false, info: null, front: 0 },   // 蓝
    { fam: 'ip6', label: 'IPv6', accent: '#9333ea', ip: null, enriching: false, info: null, front: 0 },   // 紫
  ])
  let hotCard = $state([-1, -1])            // 当前被 hover 的那张背卡(露出更多, 提示可切到此张)

  onMount(async () => {
    const r = await probeSelfIps()
    ds = r.ds
    probing = false
    const v6 = r.v6 || ((r.ds && r.ds.includes(':')) ? r.ds : null)   // ds 兜底覆盖 fakeip/代理
    fams[0].ip = r.v4
    fams[1].ip = v6
    fams.forEach((f, i) => {
      if (!f.ip) return
      f.enriching = true
      probeIp(f.ip).then((info) => { fams[i].info = info; fams[i].enriching = false })
                   .catch(() => { fams[i].enriching = false })
    })
  })

  const isDefault = (ip) => ip && ds && ip === ds

  // 该 family 当前可堆的卡片(按数据可用性增减)
  function cardsOf(f) {
    const cs = [{ kind: 'id' }]
    const info = f.info
    if (info && info.prefix != null) {
      cs.push({ kind: 'up' })
      if (info.paths && info.paths.length) cs.push({ kind: 'paths' })
    }
    return cs
  }
  const depthOf = (i, front, n) => (i - front + n) % n      // 0=最前

  // 背面只显示最靠前的 1 张(depth 1); 更深的卡片藏在它正后方(透明), 轮换/切换时再淡入。
  // hover 到这张背卡时它"稍微"探出 + 提亮, 示意可点切到它。
  function cardCss(depth, hot) {
    if (depth === 0) return `transform: none; opacity:1; z-index:30;`
    const back = depth === 1
    let tx = 7, ty = 11, rot = 2.4, sc = 0.94, op = back ? 0.82 : 0
    if (hot && back) { tx = 9.8; ty = 13.4; rot = 1.7; sc = 0.975; op = 0.98 }
    return `transform: translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${sc.toFixed(3)}) rotate(${rot.toFixed(2)}deg); opacity:${op}; z-index:${30 - depth};`
  }

  function setFront(fi, ci) { fams[fi].front = ci; hotCard[fi] = -1 }
  const stop = (e) => e.stopPropagation()
</script>

<section class="sp">
  <div class="decks">
    {#each fams as f, fi (f.fam)}
      <div class="deckwrap" data-t={f.fam} class:off={!probing && !f.ip}
           style="--ac:{(!probing && !f.ip) ? 'var(--muted)' : f.accent}">
        {#if probing}
          <div class="deck"><div class="card front" style="{cardCss(0)}">
            <div class="cbody"><span class="eyebrow">{f.label}</span><span class="ip skel">····· ·····</span></div></div></div>
        {:else if !f.ip}
          <div class="deck"><div class="card front" style="{cardCss(0)}">
            <div class="cbody"><span class="eyebrow">{f.label}</span>
              <span class="none">{f.fam === 'ip4' ? t('sp_v4none') : t('sp_v6none')}</span></div></div></div>
        {:else}
          {@const cards = cardsOf(f)}
          <div class="deck" onmouseleave={() => { hotCard[fi] = -1 }}>
            {#each cards as c, ci}
              {@const d = depthOf(ci, f.front, cards.length)}
              <div class="card" class:front={d === 0} class:peek={d === 1} style="{cardCss(d, hotCard[fi] === ci)}"
                   role={d === 1 ? 'button' : undefined} tabindex={d === 1 ? 0 : undefined}
                   title={d === 1 ? t('sp_next') : undefined}
                   onclick={() => { if (d === 1) setFront(fi, ci) }}
                   onmouseenter={() => { if (d === 1) hotCard[fi] = ci }}
                   onmouseleave={() => { if (hotCard[fi] === ci) hotCard[fi] = -1 }}
                   onkeydown={(e) => { if (d === 1 && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFront(fi, ci) } }}>
                <div class="cbody">
                  {#if c.kind === 'id'}
                    <button class="fold" class:folded={hide[fi]} onclick={(e) => { stop(e); toggleHide(fi) }}
                            title={hide[fi] ? t('sp_show') : t('sp_hide')} aria-pressed={hide[fi]}>
                      <Fa icon={hide[fi] ? iLowvis : iVisible} />
                    </button>
                    <div class="idhead">
                      <span class="eyebrow">{f.label}</span>
                      {#if isDefault(f.ip)}<span class="live" title={t('sp_default')}></span>{/if}
                    </div>
                    <div class="iprow">
                      {#if hide[fi]}
                        <span class="ip masked">{f.ip}</span>
                      {:else}
                        <button class="ip" onclick={(e) => { stop(e); onpick(f.ip) }} title={f.ip}>{f.ip}</button>
                      {/if}
                    </div>
                    {#if f.enriching}
                      <span class="sub muted">{t('sp_analyzing')}</span>
                    {:else if !f.info || f.info.prefix == null}
                      {#if f.info && f.info.origin_asn != null}
                        <div class="kv"><span class="k">{t('sp_origin')}</span>
                          <button class="lk" onclick={(e) => { stop(e); onpick('AS' + f.info.origin_asn) }}><AsnTag asn={f.info.origin_asn} /></button></div>
                      {:else}
                        <span class="sub muted">{t('sp_nocover')}</span>
                      {/if}
                    {:else}
                      <div class="kv"><span class="k">{t('sp_prefix')}</span>
                        <button class="lk mono" onclick={(e) => { stop(e); onpick(f.info.prefix) }}>{f.info.prefix}</button></div>
                      {#if f.info.origin_asn != null}
                        <div class="kv"><span class="k">{t('sp_origin')}</span>
                          <button class="lk" onclick={(e) => { stop(e); onpick('AS' + f.info.origin_asn) }}><AsnTag asn={f.info.origin_asn} /></button></div>
                      {/if}
                      {#if f.info.loc}
                        <div class="loc"><Fa icon={iLoc} /><span>{f.info.loc}</span></div>
                      {/if}
                    {/if}

                  {:else if c.kind === 'up'}
                    <span class="eyebrow">{t('sp_upstream')}</span>
                    {#if f.info.upstreams?.length}
                      <div class="ups">
                        {#each f.info.upstreams as u}
                          <button class="uchip" onclick={(e) => { stop(e); onpick('AS' + u.asn) }}>
                            <span class="unum">AS{u.asn}</span>{#if u.name}<span class="uname">{u.name}</span>{/if}
                          </button>
                        {/each}
                      </div>
                    {:else}
                      <span class="sub muted">{t('sp_noup')}</span>
                    {/if}

                  {:else if c.kind === 'paths'}
                    <span class="eyebrow">{t('sp_paths_title')} · {f.info.paths.length}{f.info.n_paths > f.info.paths.length ? '+' : ''} {t('sp_paths')}</span>
                    <div class="plist">
                      {#each f.info.paths as p}
                        <div class="prow" class:isbest={p.best}>
                          <span class="bdot" class:on={p.best} title={p.best ? t('sp_best') : ''}></span>
                          <AsPath asns={p.asns} nav arrow onnav={(asn) => onpick('AS' + asn)} />
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  /* 内边距把卡片往里收, 让卡片阴影(尤其下方/侧边)落在容器内 —— 外层 .spwrap 为折叠动画设了
     overflow:hidden, 不留余量阴影会被硬生生切掉。这里预留四周余量。 */
  .sp { margin: 14px 0 0; padding: 6px 26px 52px; }

  /* 出口卡头部一行: 族名 + (默认栈的)live 小点; 等高居中 → 两卡对齐 */
  .idhead { display: flex; align-items: center; gap: 7px; padding-right: 30px; }
  /* 默认(浏览器优先)那一栈: 一个 live 小点, 同去重路径卡的 bdot.on; 加轻微呼吸更"live" */
  .live {
    flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--signal) 30%, transparent);
    animation: livePulse 1.8s ease-in-out infinite;
  }
  @keyframes livePulse {
    0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--signal) 30%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--signal) 7%, transparent); }
  }

  /* 隐藏/显示 = 卡片右上角贴边小钮: 上/右两边直接用卡片自身的边框(本钮无边), 只有左、下两边是虚线。
     显示态 → 平齐; 隐藏态 → 被按进去(只在左+下内侧一抹浅浅的 inset 阴影, 贴边的上/右无阴影)。
     按下/弹回都走带回弹的过渡, 两个方向都有动画。 */
  .fold {
    position: absolute; top: 0; right: 0; z-index: 7;
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; cursor: pointer; border: 0;
    border-radius: 0 0 0 9px;            /* 只圆里侧(左下)那个角 */
    background: transparent; color: var(--muted);
    transition: box-shadow .32s cubic-bezier(.34, 1.56, .64, 1),
                color .15s, border-color .15s, background .2s;
  }
  .fold:hover { color: var(--fg); border-color: color-mix(in srgb, var(--muted) 85%, transparent); }
  .fold :global(svg) { width: 12px; height: 12px; }
  /* 隐藏态: 内凹 —— 浅阴影只落在左+下内侧(inset 正 X = 左、负 Y = 下), 贴边的上/右不投 */
  .fold.folded {
    background: color-mix(in srgb, var(--ac) 9%, transparent);
    box-shadow: inset 2px -2px 4px -1px rgba(0,0,0,.2);
  }

  /* 左右两叠卡片 */
  .decks { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  /* 一叠: deck 是层叠舞台(右/下各留出空间给后方卡片探头, 不被裁); ctl 在其下 */
  .deck { position: relative; height: 224px; }
  .card {
    position: absolute; top: 0; left: 0; right: 26px; height: 150px;       /* 右留 26px 给后卡探头 */
    display: flex; flex-direction: column; overflow: hidden; border-radius: 16px;
    background: linear-gradient(180deg, var(--panel), color-mix(in srgb, var(--panel) 84%, var(--bg)));
    border: 1px solid var(--line); transform-origin: 50% 60%; will-change: transform, opacity;
    box-shadow: 0 16px 34px -22px rgba(0,0,0,.5);
    transition: transform .45s cubic-bezier(.16,1,.3,1), opacity .4s ease, box-shadow .3s ease;
  }
  .card.front { cursor: default; box-shadow: 0 28px 52px -26px rgba(0,0,0,.6), 0 3px 9px rgba(0,0,0,.2); }
  .card.peek { cursor: pointer; border-color: color-mix(in srgb, var(--ac) 32%, var(--line)); }
  .card.peek .cbody { pointer-events: none; }             /* 后卡整张是"翻到此张"的点击区, 内部按钮不抢点击 */
  /* 露出的右下角放一个淡淡的 › , 提示这张可点开 */
  .card.peek::after {
    content: '›'; position: absolute; right: 9px; bottom: 5px; z-index: 4;
    font: 800 15px var(--sans); line-height: 1; color: var(--ac); opacity: .55;
    transition: opacity .2s ease, transform .2s ease;
  }
  .card.peek:hover::after { opacity: .95; transform: translateX(2px); }

  .deckwrap.off .card { box-shadow: 0 14px 30px -24px rgba(0,0,0,.45); }
  .cbody { flex: 1; min-height: 0; padding: 15px 17px 16px; display: flex; flex-direction: column; gap: 9px; }

  .eyebrow { flex: 0 0 auto; font: 800 9px var(--sans); letter-spacing: .2em; text-transform: uppercase; color: var(--ac); line-height: 1; }

  .iprow { word-break: break-all; line-height: 1.3; text-align: left; }
  .ip {
    display: inline; font: 600 15px var(--mono); text-align: left; color: var(--fg); letter-spacing: -.01em;
    background: none; border: 0; padding: 0; cursor: pointer;
  }
  button.ip:hover { color: var(--ac); }
  .ip.skel { color: var(--muted); opacity: .45; letter-spacing: .22em; cursor: default; }
  .ip.masked { filter: blur(7px); user-select: none; cursor: default; opacity: .85; }
  .none { font: 500 13px var(--sans); color: var(--muted); }
  .sub { font-size: 12.5px; }
  .muted { color: var(--muted); font-family: var(--sans); }

  .kv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .k { font: 700 9px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .lk { background: none; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 500 13.5px var(--sans); text-align: left; }
  .lk.mono { font-family: var(--mono); font-size: 13.5px; word-break: break-all; }
  .lk:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* 位置(国家/地区, 国内到城市): 钉在出口卡底部 */
  .loc { display: inline-flex; align-items: center; gap: 6px; margin-top: auto; font: 500 12px var(--sans); color: var(--muted); }
  .loc :global(svg) { width: 11px; opacity: .85; }
  .loc span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* 上游卡 */
  .ups { display: flex; flex-wrap: wrap; gap: 7px; align-content: flex-start; }
  .uchip {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 4px 10px; border-radius: 8px; background: var(--alt);
    border: 1px solid var(--line); transition: border-color .12s, background .12s, transform .08s;
  }
  .uchip:hover { border-color: var(--ac); background: color-mix(in srgb, var(--ac) 10%, transparent); }
  .uchip:active { transform: translateY(1px); }
  .unum { font: 600 12px var(--mono); color: var(--fg); }
  .uname { font: 500 11.5px var(--sans); color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* 去重路径卡: 滚动列表, 每行一条 AS_PATH */
  .plist { flex: 1; min-height: 0; overflow-y: auto; margin: 2px -6px 0; padding: 0 6px; }
  .plist::-webkit-scrollbar { width: 7px; }
  .plist::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 4px; }
  .plist { scrollbar-width: thin; }
  .prow {
    display: flex; flex-wrap: nowrap; align-items: flex-start; gap: 6px; padding: 4px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  }
  .prow:last-child { border-bottom: 0; }
  .prow :global(.aspath) { flex: 1; min-width: 0; line-height: 1.7; font-size: 11.5px; }
  .bdot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 6px; background: transparent; }
  .bdot.on { background: var(--signal); box-shadow: 0 0 0 2px color-mix(in srgb, var(--signal) 30%, transparent); }

  @media (max-width: 820px) {
    .sp { padding: 6px 16px 44px; }
    .decks { grid-template-columns: 1fr; gap: 22px; }
    .card { right: 22px; }
    .ip { font-size: 16px; }
  }
</style>
