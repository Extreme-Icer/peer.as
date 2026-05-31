<script>
  import { asnName, opCls, opOf } from '../lib/bgp.js'
  let { asn } = $props()
  let name = $derived(asnName(asn))
  let cls = $derived(opCls(asn))
  let op = $derived(opOf(asn))
</script>

{#if asn}
  <span class="asnwrap" title={op ? op + ' · ' + name : name}>
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
