<script>
  import { pathTokens } from '../lib/bgp.js'
  let { asns, dim = false } = $props()
  let toks = $derived(pathTokens(asns))
</script>

<code class="aspath" class:dim>
  {#each toks as tk}<span
      class="asn {tk.cls}"
      title={tk.op ? tk.op + ' · ' + tk.name : tk.name}
    ><b>{tk.asn}</b>{#if tk.name}<span class="an">({tk.nameShort})</span>{/if}{#if tk.tier1}<span
        class="t1" title="Tier-1">★</span>{/if}</span>{' '}{/each}
</code>

<style>
  .aspath { font-family: var(--mono); font-size: 11.5px; line-height: 1.85; color: var(--code); }
  .aspath.dim { opacity: 0.62; }
  .asn { color: var(--c, var(--code)); white-space: nowrap; }
  .asn .an { opacity: 0.72; font-size: 0.92em; font-family: var(--sans); }
  .asn .t1 { color: var(--signal); margin-left: 1px; font-size: 0.85em; }
</style>
