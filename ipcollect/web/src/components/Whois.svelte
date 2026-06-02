<script>
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { iWhois, iDb, iSpinner } from '../lib/icons.js'
  import { fetchRdap } from '../lib/rdap.js'
  import WhoisRow from './WhoisRow.svelte'
  import WhoisEntity from './WhoisEntity.svelte'

  let { kind, rkey } = $props()        // kind: 'autnum'|'ip'; rkey: ASN 号 或 前缀串
  let st = $state({ loading: true })

  // key 变化即重取(rdap.js 内存+sessionStorage 去重/缓存, 重挂载零开销)。
  $effect(() => {
    const k = rkey, kd = kind
    if (k == null || k === '') { st = { empty: true }; return }
    st = { loading: true }
    let dead = false
    fetchRdap(kd, String(k))
      .then(d => { if (!dead) st = { data: d } })
      .catch(e => { if (!dead) st = { error: e.message } })
    return () => { dead = true }
  })
</script>

<div class="whois">
  <h3 class="dsec"><Fa icon={iWhois} /> {t('whois_title')}</h3>
  {#if st.loading}
    <div class="wstat"><Fa icon={iSpinner} spin /> {t('querying')}</div>
  {:else if st.error}
    <div class="wstat err">{st.error}</div>
  {:else if st.empty}
    <div class="wstat muted">{t('whois_none')}</div>
  {:else if st.data}
    {@const d = st.data}
    <div class="whead-rows">
      {#each d.head as r}<WhoisRow rowKey={r.key} value={r.value} />{/each}
    </div>
    {#if d.entities?.length}
      <div class="wents">
        {#each d.entities as e}<WhoisEntity entity={e} />{/each}
      </div>
    {/if}
    {#each d.remarks || [] as r}
      <div class="wremark">{#if r.title}<b>{r.title}：</b>{/if}{r.value}</div>
    {/each}
    {#if d.source}
      <div class="wsrc"><Fa icon={iDb} /> {t('whois_src')}: {d.source}</div>
    {/if}
  {/if}
</div>

<style>
  .whois { margin-top: 4px; }
  .dsec {
    font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent);
    margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px;
    display: flex; align-items: center; gap: 7px;
  }
  .wstat { color: var(--muted); font-size: 12px; padding: 6px 0; }
  .wstat.err { color: var(--bad, #dc2626); }
  .wstat.muted { color: var(--muted); }
  .whead-rows { margin-bottom: 4px; }
  .wents { margin-top: 6px; border-top: 1px dashed var(--line2); padding-top: 6px; }
  .wremark { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin-top: 8px; white-space: pre-line; }
  .wsrc { font-size: 10.5px; color: var(--muted); margin-top: 10px; display: flex; align-items: center; gap: 6px; opacity: .8; }
  .wsrc :global(svg) { width: 10px; }
</style>
