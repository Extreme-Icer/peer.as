<script>
  // 数据导出浮窗(S.exportOpen)。勾选要导出的列 -> exportCsv 复用当前搜索查询(去 offset、大上限)取全量 -> 下载 CSV。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { iClose, iDownload } from '../lib/icons.js'
  import { exportColumns, exportCsv } from '../lib/queries.js'

  const CAP = 100000
  let cols = $state([])
  let sel = $state(new Set())
  let busy = $state(false)

  // 打开时拉取当前可导出列并默认全选。用局部 c 派生 sel —— 切勿在本 effect 内再读 reactive 的 cols,
  // 否则「写 cols → 读 cols」自依赖会触发 effect_update_depth_exceeded 死循环(整个浮窗失去交互)。
  $effect(() => {
    if (!S.exportOpen) return
    const c = exportColumns()
    cols = c
    sel = new Set(c.map(x => x.key))
    busy = false
  })

  const close = () => { if (!busy) S.exportOpen = false }
  function toggle(k) { sel.has(k) ? sel.delete(k) : sel.add(k); sel = new Set(sel) }
  const selAll = () => (sel = new Set(cols.map(c => c.key)))
  const selNone = () => (sel = new Set())

  async function doExport() {
    if (!sel.size || busy) return
    busy = true
    const r = await exportCsv([...sel])
    busy = false
    if (r.ok) {
      S.msg = t('exp_done').replace('{n}', (r.n || 0).toLocaleString())
        + (r.capped ? t('exp_capped').replace('{cap}', CAP.toLocaleString()) : '')
      S.exportOpen = false
    } else {
      S.msg = t('exp_fail') + (r.error ? ': ' + r.error : '')
    }
  }
</script>

{#if S.exportOpen}
  <div class="modal" onclick={(e) => e.target === e.currentTarget && close()} role="presentation">
    <div class="modal-box">
      <button class="close" onclick={close} aria-label="close"><Fa icon={iClose} /></button>
      <h2><Fa icon={iDownload} /> {t('exp_title')}</h2>
      <p class="desc">{t('exp_desc')}</p>

      <div class="bulk">
        <button onclick={selAll}>{t('exp_all')}</button>
        <button onclick={selNone}>{t('exp_none')}</button>
      </div>

      <div class="cols">
        {#each cols as c}
          <label class="col" class:on={sel.has(c.key)}>
            <input type="checkbox" checked={sel.has(c.key)} onchange={() => toggle(c.key)} />
            <span>{c.label}</span>
          </label>
        {/each}
      </div>

      <div class="actions">
        <button class="cancel" onclick={close} disabled={busy}>{t('exp_cancel')}</button>
        <button class="go" disabled={!sel.size || busy} onclick={doExport}>
          <Fa icon={iDownload} /> {busy ? t('exp_busy') : t('exp_do')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(2,6,14,.62); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px; overflow: auto; z-index: 50; animation: fade .15s ease; }
  @keyframes fade { from { opacity: 0 } }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 440px; width: 100%; padding: 22px 24px; box-shadow: 0 24px 70px rgba(0,0,0,.5); position: relative; }
  .close { position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); cursor: pointer; }
  .close:hover { color: var(--accent); border-color: var(--accent); }
  h2 { margin: 0 0 6px; font: 700 16px var(--sans); color: var(--fg); display: flex; align-items: center; gap: 9px; }
  h2 :global(svg) { color: var(--accent); width: 15px; }
  .desc { margin: 0 0 14px; font-size: 12.5px; color: var(--muted); line-height: 1.6; }
  .bulk { display: flex; gap: 8px; margin-bottom: 10px; }
  .bulk button { background: transparent; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font: 600 11px var(--sans); padding: 4px 10px; cursor: pointer; }
  .bulk button:hover { color: var(--accent); border-color: var(--accent); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; margin-bottom: 18px; }
  .col { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; font-size: 12.5px; color: var(--fg); transition: all .12s; }
  .col:hover { border-color: var(--accent); }
  .col.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .col input { accent-color: var(--accent); cursor: pointer; flex: 0 0 auto; }
  .col span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; }
  .cancel { background: transparent; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font: 600 12.5px var(--sans); padding: 8px 16px; cursor: pointer; }
  .cancel:hover:not(:disabled) { color: var(--fg); border-color: var(--muted); }
  .go { display: inline-flex; align-items: center; gap: 7px; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 8px; font: 700 12.5px var(--sans); padding: 8px 18px; cursor: pointer; box-shadow: 0 2px 12px var(--accent-dim); transition: filter .12s; }
  .go:hover:not(:disabled) { filter: brightness(1.08); }
  .go:disabled, .cancel:disabled { opacity: .45; cursor: default; }
  .go :global(svg) { width: 12px; }
  @media (max-width: 560px) { .cols { grid-template-columns: 1fr; } }
</style>
