<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { compilePathQuery, asnName, parseBest } from '../lib/bgp.js'
  import { showInsight, showAsn, closeInsight, navBack, navForward, navCanBack, navCanFwd } from '../lib/queries.js'
  import { iClose, iStar, iUp, iDown, iSpinner, iArrowL, iArrowR } from '../lib/icons.js'
  import PathGraph from './PathGraph.svelte'
  import AsPath from './AsPath.svelte'
  import Whois from './Whois.svelte'
  import AsnDetail from './AsnDetail.svelte'

  let ins = $derived(S.insight)
  let pq = $derived(compilePathQuery(S.filters.path))
  let canBack = $derived(navCanBack())
  let canFwd = $derived(navCanFwd())

  // 拖拽调宽
  let dragging = false
  function startDrag(e) {
    dragging = true; document.body.style.userSelect = 'none'; e.preventDefault()
    const move = ev => {
      if (!dragging) return
      S.detailW = Math.min(72, Math.max(38, (window.innerWidth - ev.clientX) / window.innerWidth * 100))
      localStorage.setItem('ipc-detail-w', S.detailW.toFixed(1))
    }
    const up = () => { dragging = false; document.body.style.userSelect = ''; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
</script>

{#if S.detailKind}
  <aside class="detail open" style:flex-basis="{S.detailW}%" style:width="{S.detailW}%">
    <div class="dragbar" onmousedown={startDrag} role="separator" aria-orientation="vertical"></div>
    <div class="dbody">
      <div class="dtools">
        <div class="navbtns">
          <button class="navb" disabled={!canBack} onclick={navBack} title={t('nav_back')} aria-label={t('nav_back')}><Fa icon={iArrowL} /></button>
          <button class="navb" disabled={!canFwd} onclick={navForward} title={t('nav_fwd')} aria-label={t('nav_fwd')}><Fa icon={iArrowR} /></button>
        </div>
        <button class="close" onclick={closeInsight} title={t('detail_close')} aria-label={t('detail_close')}><Fa icon={iClose} /></button>
      </div>

      {#if S.detailKind === 'asn'}
        <AsnDetail />
      {:else if ins?.loading}
        <div class="dload"><Fa icon={iSpinner} spin /> {t('querying')}</div>
      {:else if ins?.error}
        <div class="dload err">{ins.error}</div>
      {:else if ins}
        <h2>{ins.prefix} <span class="loc">· {ins.loc}</span></h2>
        <div class="pill">
          origin asn <button class="originlink" onclick={() => showAsn(ins.origin_asn)} disabled={!ins.origin_asn}><b>{ins.origin_asn || ''}</b>{ins.origin_name ? ` (${ins.origin_name})` : ''}</button>
          · {ins.paths.length} {t('distinct')} / {ins.n_paths || 0} {t('peers')}
          {#if S.meta?.dfz_ref}
            · <span class="badge {ins.lowvis ? 'b-warn' : 'b-ok'}">{ins.n_paths || 0}/{S.meta.dfz_ref} {ins.lowvis ? t('lowvis') : 'DFZ'}</span>
          {/if}
        </div>

        <h3 class="dsec">{t('graph_title')}</h3>
        <PathGraph rec={{ paths: ins.paths, origin_asn: ins.origin_asn, prefix: ins.prefix }} />

        <div class="rel">
          <div class="relbox">
            <b><Fa icon={iUp} /> {t('sup')}</b>
            {#if ins.sup.length}
              {#each ins.sup as r, i}{#if i}<span class="sub-sep">⊂</span>{/if}<button class="rellink" onclick={() => showInsight(r.pid, r.prefix)}>{r.prefix}</button>{/each}
            {:else}<span class="muted">{t('none_in_db')}</span>{/if}
          </div>
          <div class="relbox">
            <b><Fa icon={iDown} /> {t('sub')}</b>
            {#if ins.sub.length}
              <div class="rels">{#each ins.sub as r}<button class="rellink" onclick={() => showInsight(r.pid, r.prefix)}>{r.prefix}</button>{/each}</div>
            {:else}<span class="muted">{t('none_in_db')}</span>{/if}
          </div>
          <div class="relnote">{t('rel_note')}</div>
        </div>

        <h3 class="dsec">{t('paths_all')}</h3>
        <table class="paths">
          <thead><tr><th>#peer</th><th>len</th><th>AS_PATH</th></tr></thead>
          <tbody>
            {#each ins.paths as g}
              <tr class:hit={pq.hasInclude && pq.test(g.asns)}>
                <td class="num">{g.peers}</td>
                <td class="num">{g.asns.length}</td>
                <td>{#if g.is_best}<span class="star"><Fa icon={iStar} /></span> {/if}<AsPath asns={g.asns} /></td>
              </tr>
            {/each}
          </tbody>
        </table>

        <Whois kind="ip" rkey={ins.prefix} />
      {/if}
    </div>
  </aside>
{/if}

<style>
  .detail { flex: 0 0 42%; display: flex; background: var(--inbg); border-left: 1px solid var(--line); position: sticky; top: 0; height: 100vh; overflow: hidden; }
  .dragbar { flex: 0 0 6px; cursor: col-resize; background: var(--line); transition: background .12s; }
  .dragbar:hover, .dragbar:active { background: var(--accent); }
  .dbody { flex: 1; min-width: 0; overflow: auto; padding: 14px 22px 40px; }
  /* 顶部工具条: 前进/后退(左) + 关闭(右) */
  .dtools { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; }
  .navbtns { display: inline-flex; gap: 4px; }
  .navb { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: transparent; border: 1px solid var(--line2); border-radius: 7px; color: var(--muted); cursor: pointer; font-size: 12px; transition: all .12s; }
  .navb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .navb:disabled { opacity: .35; cursor: default; }
  .close { background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 17px; padding: 2px 4px; }
  .close:hover { color: var(--accent); }
  .originlink { background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--link); font: inherit; }
  .originlink b { color: var(--link); font-family: var(--mono); }
  .originlink:hover:not(:disabled) { text-decoration: underline; }
  .originlink:disabled { cursor: default; color: var(--muted); }
  .originlink:disabled b { color: var(--fg); }
  .dload { color: var(--muted); padding: 30px 0; font-size: 13px; }
  .dload.err { color: var(--bad, #dc2626); }
  h2 { font: 600 15px var(--mono); margin: 0 0 7px; color: var(--fg); }
  h2 .loc { color: var(--muted); font-weight: 400; font-size: 13px; font-family: var(--sans); }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; }
  .pill b { color: var(--fg); font-family: var(--mono); }
  .dsec { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 7px; }
  .rel { margin-top: 8px; }
  .relbox { margin: 10px 0 0; font-size: 12px; }
  .relbox b { color: var(--muted); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  .rels { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 5px 11px; }
  .rellink { background: transparent; border: 0; color: var(--link); cursor: pointer; font: 12px var(--mono); padding: 0; }
  .rellink:hover { text-decoration: underline; }
  .sub-sep { color: var(--muted); margin: 0 6px; }
  .muted { color: var(--muted); }
  .relnote { color: var(--muted); font-size: 11px; margin: 10px 0 2px; line-height: 1.5; }
  table.paths { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.paths th { text-align: left; font: 700 10px var(--mono); text-transform: uppercase; color: var(--muted); padding: 4px 9px; border-bottom: 1px solid var(--line); }
  table.paths td { padding: 5px 9px; border-bottom: 1px solid var(--line2); vertical-align: top; }
  table.paths td.num { font-family: var(--mono); text-align: right; color: var(--muted); white-space: nowrap; }
  table.paths tr.hit { background: var(--hit); }
  .star { color: var(--signal); }
  @media (max-width: 820px) {
    .detail { position: fixed; inset: 0; width: 100% !important; flex-basis: 100% !important; z-index: 40; }
    .dragbar { display: none; }
  }
</style>
