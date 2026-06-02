<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { showInsight, showAsn, scanNeighbors } from '../lib/queries.js'
  import { ccLabel } from '../lib/bgp.js'
  import { iPrefix, iUp, iDown, iNodes, iSpinner } from '../lib/icons.js'
  import Whois from './Whois.svelte'
  import AsnTag from './AsnTag.svelte'

  let a = $derived(S.asnView)
  let total = $derived((a?.count4 || 0) + (a?.count6 || 0))
</script>

{#if a}
  <h2>AS{a.asn} {#if a.name}<span class="loc">· {a.name}</span>{/if}</h2>

  {#if a.error}
    <div class="dload err">{a.error}</div>
  {:else}
    <div class="pill">
      {#if a.loading}<Fa icon={iSpinner} spin /> {t('querying')}
      {:else}
        <Fa icon={iPrefix} /> {total.toLocaleString()} {t('asn_originated')}
        {#if a.count4 || a.count6}<span class="fam">· IPv4 {(a.count4 || 0).toLocaleString()} · IPv6 {(a.count6 || 0).toLocaleString()}</span>{/if}
      {/if}
    </div>

    <!-- WHOIS / RDAP -->
    <Whois kind="autnum" rkey={a.asn} />

    {#if !a.loading}
      <!-- 通告前缀 -->
      <h3 class="dsec"><Fa icon={iPrefix} /> {t('asn_originated')}{#if total} · {total.toLocaleString()}{/if}</h3>
      {#if a.prefixes?.length}
        <div class="plist">
          {#each a.prefixes as p}
            <button class="prow" onclick={() => showInsight(p.pid, p.prefix)}>
              <span class="px">{p.prefix}</span>
              <span class="pm">{ccLabel(p.cc)} · {p.n_paths}</span>
            </button>
          {/each}
        </div>
        {#if total > a.prefixes.length}<div class="more">… {(total - a.prefixes.length).toLocaleString()} more</div>{/if}
      {:else}
        <div class="muted small">{t('asn_no_origin')}</div>
      {/if}

      <!-- 观测上游(据通告前缀最优路径) -->
      {#if a.upstreams?.length}
        <h3 class="dsec"><Fa icon={iUp} /> {t('asn_upstreams')}</h3>
        <div class="taglist">
          {#each a.upstreams as u}
            <button class="tagbtn" onclick={() => showAsn(u.asn)} title="AS{u.asn}"><AsnTag asn={u.asn} /><span class="cnt">{u.n}</span></button>
          {/each}
        </div>
        <div class="relnote">{t('asn_upstream_note')}</div>
      {/if}

      <!-- 完整邻居(按需全表扫) -->
      <h3 class="dsec"><Fa icon={iNodes} /> {t('asn_neigh')}</h3>
      {#if !a.neigh}
        <button class="scanbtn" onclick={() => scanNeighbors(a.asn)}><Fa icon={iNodes} /> {t('asn_neigh_btn')}</button>
        <div class="relnote">{t('asn_neigh_note')}</div>
      {:else if a.neigh.loading}
        <div class="muted small"><Fa icon={iSpinner} spin /> {t('searching_global')}</div>
      {:else if a.neigh.error}
        <div class="dload err">{a.neigh.error}</div>
      {:else}
        <div class="ncol">
          <b><Fa icon={iUp} /> {t('asn_neigh_up')}</b>
          {#if a.neigh.up.length}
            <div class="taglist">{#each a.neigh.up as u}<button class="tagbtn" onclick={() => showAsn(u.asn)}><AsnTag asn={u.asn} /><span class="cnt">{u.n}</span></button>{/each}</div>
          {:else}<span class="muted small">{t('none_in_db')}</span>{/if}
        </div>
        <div class="ncol">
          <b><Fa icon={iDown} /> {t('asn_neigh_down')}</b>
          {#if a.neigh.down.length}
            <div class="taglist">{#each a.neigh.down as u}<button class="tagbtn" onclick={() => showAsn(u.asn)}><AsnTag asn={u.asn} /><span class="cnt">{u.n}</span></button>{/each}</div>
          {:else}<span class="muted small">{t('none_in_db')}</span>{/if}
        </div>
        <div class="relnote">{t('asn_scanned').replace('{n}', a.neigh.scanned.toLocaleString())}{a.neigh.capped ? t('asn_capped') : ''}</div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  h2 { font: 600 15px var(--mono); margin: 0 0 7px; color: var(--fg); }
  h2 .loc { color: var(--muted); font-weight: 400; font-size: 13px; font-family: var(--sans); }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pill .fam { color: var(--muted); }
  .dsec { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 7px; }
  .dload.err { color: var(--bad, #dc2626); font-size: 13px; padding: 10px 0; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .plist { max-height: 280px; overflow: auto; display: flex; flex-direction: column; border: 1px solid var(--line2); border-radius: 8px; }
  .prow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; background: transparent; border: 0; border-bottom: 1px solid var(--line2); cursor: pointer; padding: 5px 10px; text-align: left; }
  .prow:last-child { border-bottom: 0; }
  .prow:hover { background: var(--line2); }
  .prow .px { font: 12px var(--mono); color: var(--link); }
  .prow .pm { font-size: 11px; color: var(--muted); font-family: var(--sans); white-space: nowrap; }
  .more { font-size: 11px; color: var(--muted); padding: 6px 2px 0; }
  .taglist { display: flex; flex-wrap: wrap; gap: 6px 8px; }
  .tagbtn { display: inline-flex; align-items: center; gap: 4px; background: var(--inbg); border: 1px solid var(--line2); border-radius: 7px; cursor: pointer; padding: 3px 8px; font-size: 11.5px; }
  .tagbtn:hover { border-color: var(--accent); }
  .tagbtn .cnt { font: 10px var(--mono); color: var(--muted); background: var(--line2); border-radius: 999px; padding: 0 5px; }
  .relnote { color: var(--muted); font-size: 11px; margin: 8px 0 2px; line-height: 1.5; }
  .scanbtn { display: inline-flex; align-items: center; gap: 7px; background: var(--inbg); color: var(--accent); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; padding: 7px 14px; font: 600 12px var(--sans); transition: all .12s; }
  .scanbtn:hover { border-color: var(--accent); background: var(--accent-dim); }
  .ncol { margin: 10px 0 0; }
  .ncol b { color: var(--muted); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 6px; }
  .ncol b :global(svg) { color: var(--accent); }
</style>
