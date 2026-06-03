<script>
  // 域名详情面板(右侧抽屉, detailKind==='domain')。逻辑与 AsnDetail 一致:
  // 头部 + 概要 pill(A/AAAA/NS 计数, 取自 S.dns) + WHOIS/RDAP(域名注册信息, Whois kind='domain')。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { iGlobal } from '../lib/icons.js'
  import Whois from './Whois.svelte'

  let d = $derived(S.domainView)
  // 概要计数: 仅当 S.dns 是同一域名时可用(下钻到子页后仍保留)。
  let dns = $derived(S.dns?.domain === d?.domain ? S.dns : null)
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

  <!-- WHOIS / RDAP（域名注册信息） -->
  <Whois kind="domain" rkey={d.domain} />
{/if}

<style>
  h2 { font: 600 15px var(--mono); margin: 0 0 8px; color: var(--fg); display: flex; align-items: center; gap: 8px; word-break: break-all; }
  h2 :global(svg) { color: var(--accent); width: 14px; flex: 0 0 auto; }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; display: flex; flex-wrap: wrap; gap: 5px 7px; }
  .pill span { background: var(--inbg); border: 1px solid var(--line2); border-radius: 6px; padding: 1px 8px; font-family: var(--mono); }
  @media (max-width: 820px) { h2 { margin-top: 16px; } }
</style>
