<script>
  import { asnName, asnOrg, opCls, opOf } from '../lib/bgp.js'
  let { asn } = $props()
  let name = $derived(asnName(asn))
  let cls = $derived(opCls(asn))
  let op = $derived(opOf(asn))
  let org = $derived(asnOrg(asn))           // GeoLite organization 全名(hover 显示)
  let tip = $derived([op, name, org].filter(Boolean).join(' · ') || `AS${asn}`)
</script>

{#if asn}
  <span class="asnwrap" title={tip}>
    <span class="num">{asn}</span>{#if name}<span class="badge {cls || 'b-mute'}">{name}</span>{/if}
  </span>
{:else}
  <span class="muted">—</span>
{/if}

<style>
  .asnwrap { display: inline-flex; align-items: center; gap: 5px; }
  .num { font-family: var(--mono); color: var(--fg); }
  .muted { color: var(--muted); }
</style>
