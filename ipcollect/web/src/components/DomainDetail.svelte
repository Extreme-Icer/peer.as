<script>
  // 域名详情面板(右侧抽屉, detailKind==='domain')。逻辑与 AsnDetail 一致:
  // 头部 + 概要 pill(A/AAAA/NS 计数, 取自 S.dns) + WHOIS/RDAP(域名注册信息, Whois kind='domain')。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { registrableDomain } from '../lib/bgp.js'
  import { iGlobal } from '../lib/icons.js'
  import { features } from '../lib/site.js'
  import Whois from './Whois.svelte'

  let d = $derived(S.domainView)
  // 概要计数: 仅当 S.dns 是同一域名时可用(下钻到子页后仍保留)。
  let dns = $derived(S.dns?.domain === d?.domain ? S.dns : null)
  // WHOIS/RDAP 查可注册域名(根域名): 子域名查 RDAP 通常无结果, 自动缩略到 eTLD+1。
  let root = $derived(d ? registrableDomain(d.domain) : '')
  let isSub = $derived(!!root && root !== d?.domain)
  // whois 键: peeras(RDAP)用根域名; dn42(registry)用完整域名, 由 registry.js 逐级回退到登记的 zone。
  let whoisKey = $derived(features.rdapWhois ? root : (d?.domain || ''))
</script>

{#if d}
  <h2><Fa icon={iGlobal} /> {d.domain}</h2>

  {#if dns && !dns.loading && !dns.error}
    <div class="pill">
      {#if dns.a?.length}<span>A {dns.a.length}</span>{/if}
      {#if dns.aaaa?.length}<span>AAAA {dns.aaaa.length}</span>{/if}
      {#each dns.others || [] as g}<span>{g.type} {g.records.length}</span>{/each}
    </div>
  {/if}

  {#if isSub && features.rdapWhois}
    <div class="subnote">{t('whois_root_note')} <b>{root}</b></div>
  {/if}

  <!-- WHOIS（域名注册信息）—— peeras: RDAP 查根域名; dn42: registry 查域名 zone -->
  <Whois kind="domain" rkey={whoisKey} />
{/if}

<style>
  h2 { font: 600 15px var(--mono); margin: 0 0 8px; color: var(--fg); display: flex; align-items: center; gap: 8px; word-break: break-all; }
  h2 :global(svg) { color: var(--accent); width: 14px; flex: 0 0 auto; }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; display: flex; flex-wrap: wrap; gap: 5px 7px; }
  .pill span { background: var(--inbg); border: 1px solid var(--line2); border-radius: 6px; padding: 1px 8px; font-family: var(--mono); }
  .subnote { font-size: 11.5px; color: var(--muted); margin: 2px 0 4px; line-height: 1.5; }
  .subnote b { color: var(--link); font-family: var(--mono); font-weight: 600; word-break: break-all; }
  @media (max-width: 820px) { h2 { margin-top: 16px; } }
</style>
