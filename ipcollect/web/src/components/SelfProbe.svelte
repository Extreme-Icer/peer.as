<script>
  // 首页「你的接入」自助探测卡片。
  // 用 test-ipv6.com 的三个 JSONP 端点(ipv4./ipv6./ds.)强制 v4/v6/双栈连接, 拿到本机两个栈的出口地址,
  // 再用库内引擎(probeIp)富集每个地址: 覆盖前缀 / origin ASN / 直接观测上游。
  // 纯展示 + 可点击下钻(onpick → 把对象塞进首页查询框跑一次)。探测/富集失败都静默退化, 不阻塞首页。
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { probeSelfIps } from '../lib/geo.js'
  import { probeIp } from '../lib/queries.js'
  import { iVisible, iLowvis } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'

  let { onpick = () => {} } = $props()

  // 隐藏 IP 开关(截图/隐私用): 仅遮挡出口地址本身, 富集信息照常显示。状态记忆于 localStorage。
  const HIDE_KEY = 'ipc-hide-self-ip'
  let hideIp = $state((() => { try { return localStorage.getItem(HIDE_KEY) === '1' } catch (e) { return false } })())
  function toggleHide() {
    hideIp = !hideIp
    try { localStorage.setItem(HIDE_KEY, hideIp ? '1' : '0') } catch (e) { /* 隐私模式忽略 */ }
  }

  let probing = $state(true)        // JSONP 探测出口地址阶段
  let ds = $state(null)             // 双栈端点返回的地址 = 浏览器默认优先栈
  // 每个 family 一格: { ip, enriching, info }(info=probeIp 结果)
  let fams = $state([
    { fam: 'ip4', label: 'IPv4', ip: null, enriching: false, info: null },
    { fam: 'ip6', label: 'IPv6', ip: null, enriching: false, info: null },
  ])

  onMount(async () => {
    const r = await probeSelfIps()
    ds = r.ds
    probing = false
    // 双栈端点返回 v6 但强制 v6 端点没回(如本地 fakeip / 代理场景), 也算探测到了 v6 出口。
    const v6 = r.v6 || ((r.ds && r.ds.includes(':')) ? r.ds : null)
    fams[0].ip = r.v4
    fams[1].ip = v6
    // 对探测到的每个出口地址做库内富集(并行); 引擎首次会在内部 ensureEngine, 故可能稍慢。
    fams.forEach((f, i) => {
      if (!f.ip) return
      f.enriching = true
      probeIp(f.ip).then((info) => { fams[i].info = info; fams[i].enriching = false })
                   .catch(() => { fams[i].enriching = false })
    })
  })

  const isDefault = (ip) => ip && ds && ip === ds
</script>

<section class="sp">
  <div class="sp-head">
    <span class="sp-title">{t('sp_title')}</span>
    <button class="eye" class:on={hideIp} onclick={toggleHide}
            title={hideIp ? t('sp_show') : t('sp_hide')} aria-pressed={hideIp}>
      <Fa icon={hideIp ? iLowvis : iVisible} />
    </button>
  </div>

  <div class="sp-rows">
    {#each fams as f (f.fam)}
      <div class="row" data-t={f.fam}>
        <div class="top">
          <span class="fam">{f.label}</span>

          {#if probing}
            <span class="ip skel">·····</span>
          {:else if !f.ip}
            <span class="none">{f.fam === 'ip4' ? t('sp_v4none') : t('sp_v6none')}</span>
          {:else if hideIp}
            <span class="ip masked">{f.ip}</span>
            {#if isDefault(f.ip)}<span class="dtag">{t('sp_default')}</span>{/if}
          {:else}
            <button class="ip" onclick={() => onpick(f.ip)} title={f.ip}>{f.ip}</button>
            {#if isDefault(f.ip)}<span class="dtag">{t('sp_default')}</span>{/if}
          {/if}
        </div>

        {#if !probing && f.ip}
          <div class="meta">
            {#if f.enriching}
              <span class="muted">{t('sp_analyzing')}</span>
            {:else if !f.info || f.info.prefix == null}
              <span class="muted">{f.info && f.info.origin_asn != null ? '' : t('sp_nocover')}</span>
              {#if f.info && f.info.origin_asn != null}
                <span class="kv"><span class="k">{t('sp_origin')}</span>
                  <button class="lk" onclick={() => onpick('AS' + f.info.origin_asn)}><AsnTag asn={f.info.origin_asn} /></button>
                </span>
              {/if}
            {:else}
              <span class="kv"><span class="k">{t('sp_prefix')}</span>
                <button class="lk mono" onclick={() => onpick(f.info.prefix)}>{f.info.prefix}</button>
              </span>
              {#if f.info.origin_asn != null}
                <span class="kv"><span class="k">{t('sp_origin')}</span>
                  <button class="lk" onclick={() => onpick('AS' + f.info.origin_asn)}><AsnTag asn={f.info.origin_asn} /></button>
                </span>
              {/if}
              {#if f.info.upstreams?.length}
                <span class="kv up" title={t('sp_upstream_hint')}>
                  <span class="k">{t('sp_upstream')}</span>
                  {#each f.info.upstreams as u}
                    <button class="uchip" onclick={() => onpick('AS' + u.asn)}>
                      <span class="unum">AS{u.asn}</span>{#if u.name}<span class="uname">{u.name}</span>{/if}
                    </button>
                  {/each}
                </span>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  .sp {
    margin: 18px 2px 0; padding: 14px 16px 15px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 18px 50px -34px rgba(0,0,0,.55);
  }
  .sp-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .sp-title { font: 700 13px var(--sans); letter-spacing: .04em; color: var(--fg); }

  /* 隐藏 IP 开关(右上角眼睛) */
  .eye {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border-radius: 8px; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid transparent;
    transition: color .12s, background .12s, border-color .12s;
  }
  .eye:hover { color: var(--fg); background: var(--alt); border-color: var(--line); }
  .eye.on { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 34%, transparent); }
  .eye :global(svg) { width: 14px; }

  /* 双栏: 左 v4(窄)右 v6(宽)。v4 地址短、v6 长 → 给 v6 更多宽度, 让完整 IPv6 一行放得下。
     stretch → 两格等高; .top 预留高度 → 万一窄屏换行也不致两边错位。 */
  .sp-rows { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 5fr); gap: 12px; align-items: stretch; }
  .row {
    display: flex; flex-direction: column;
    padding: 11px 13px; border-radius: 10px;
    background: var(--inbg); border: 1px solid var(--line);
    border-left: 3px solid var(--tc, var(--muted));
  }
  /* 地址行: 预留 ~2 行高度并居中 → IPv6 换行 / IPv4 单行时两栏顶部仍对齐 */
  .top {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
  }
  [data-t='ip4'] { --tc: #3b82f6; }
  [data-t='ip6'] { --tc: #8b5cf6; }

  .fam {
    flex: 0 0 auto; font: 700 10.5px var(--sans); letter-spacing: .07em; text-transform: uppercase;
    color: var(--tc); padding: 3px 8px; border-radius: 6px;
    background: color-mix(in srgb, var(--tc) 13%, transparent);
    border: 1px solid color-mix(in srgb, var(--tc) 30%, transparent);
  }

  .ip {
    font: 600 15px var(--mono); color: var(--fg); letter-spacing: -.01em; word-break: break-all;
    background: none; border: 0; padding: 0; cursor: pointer; text-align: left;
  }
  button.ip:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  .ip.skel { color: var(--muted); opacity: .5; letter-spacing: .2em; cursor: default; }
  /* 隐藏态: 模糊遮挡(保持原宽度/换行 → 不影响两栏对齐), 不可选中/点击 */
  .ip.masked { filter: blur(7px); user-select: none; cursor: default; opacity: .85; }
  .none { font: 500 12.5px var(--sans); color: var(--muted); }

  .dtag {
    flex: 0 0 auto; font: 700 9.5px var(--sans); letter-spacing: .06em; text-transform: uppercase;
    color: var(--signal); padding: 2px 7px; border-radius: 999px;
    background: color-mix(in srgb, var(--signal) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--signal) 30%, transparent);
  }

  /* 富集明细: 前缀 / origin / 上游, 在地址行下方 */
  .meta {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px;
    margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--line);
  }
  .muted { font: 500 12px var(--sans); color: var(--muted); }
  .kv { display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .k { font: 600 10px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }

  .lk { background: none; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 500 13px var(--sans); }
  .lk.mono { font-family: var(--mono); font-size: 13.5px; word-break: break-all; }
  .lk:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* 上游 chip: AS号 + 名称 */
  .up { gap: 6px 8px; }
  .uchip {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 3px 9px; border-radius: 7px; background: var(--alt);
    border: 1px solid var(--line); transition: border-color .12s, background .12s;
  }
  .uchip:hover { border-color: var(--accent); background: var(--accent-dim); }
  .unum { font: 600 12px var(--mono); color: var(--fg); }
  .uname { font: 500 11.5px var(--sans); color: var(--muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @media (max-width: 820px) {
    .sp-rows { grid-template-columns: 1fr; }
    .ip { font-size: 14px; }
    .uname { max-width: 110px; }
  }
</style>
