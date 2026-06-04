<script>
  // as-set 嵌套树的一个节点(递归)。kind='asn' = 叶子(点击下钻 ASN 详情); kind='set' = 可展开(点一层懒查一层)。
  // 环检测: ancestors = 从根到此的 set_key 集合; 子 set 已在祖先里 -> 标 ↻ 不可展开。depth 上限防失控。
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { asnName } from '../lib/bgp.js'
  import { showAsn, loadAsSetMembers } from '../lib/queries.js'
  import { iChevR, iChevD, iSpinner } from '../lib/icons.js'
  import Self from './AsSetTree.svelte'

  let { node, ancestors = new Set(), depth = 0 } = $props()
  const MAXDEPTH = 24

  let open = $state(false)
  let loading = $state(false)
  let kids = $state(null)        // null=未加载; 数组=已加载(可能空)
  let loaded = $state(false)

  let isAsn = $derived(node.kind === 'asn')
  let asn = $derived(isAsn ? Number(String(node.val).replace(/^AS/i, '')) : null)
  let setKey = $derived(!isAsn ? node.val : null)                         // 子 set_key(SOURCE::NAME) 或裸名(未解析)
  let setSource = $derived(setKey && setKey.includes('::') ? setKey.split('::')[0] : null)
  let setName = $derived(setKey ? (setKey.includes('::') ? setKey.split('::').slice(1).join('::') : setKey) : null)
  let cycle = $derived(setKey ? ancestors.has(setKey) : false)
  let tooDeep = $derived(depth >= MAXDEPTH)
  let expandable = $derived(!isAsn && !cycle && !tooDeep)
  let childAnc = $derived(setKey ? new Set([...ancestors, setKey]) : ancestors)

  async function toggle() {
    if (!expandable) return
    open = !open
    if (open && !loaded) {
      loading = true
      try { kids = await loadAsSetMembers(setKey) } catch { kids = [] }
      loaded = true; loading = false
    }
  }
</script>

<div class="node">
  {#if isAsn}
    <button class="row leaf" onclick={() => showAsn(asn)}>
      <span class="tw"></span><b class="asn">AS{asn}</b>{#if asnName(asn)}<span class="nm">{asnName(asn)}</span>{/if}
    </button>
  {:else}
    <button class="row branch" class:cyc={cycle} onclick={toggle} disabled={!expandable} title={cycle ? t('asset_cycle') : (tooDeep ? t('asset_too_deep') : '')}>
      <span class="tw">{#if loading}<Fa icon={iSpinner} spin />{:else if expandable}<Fa icon={open ? iChevD : iChevR} />{:else}<span class="dot">·</span>{/if}</span>
      <b class="setn">{setName}</b>{#if setSource}<span class="src">{setSource}</span>{:else}<span class="src unr" title={t('asset_unresolved')}>?</span>{/if}{#if cycle}<span class="cyc-m" title={t('asset_cycle')}>↻</span>{/if}
    </button>
  {/if}
  {#if open}
    <div class="kids">
      {#if kids && kids.length}
        {#each kids as k (k.ord)}<Self node={k} ancestors={childAnc} depth={depth + 1} />{/each}
      {:else if kids}
        <div class="empty">{t('asset_no_members')}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .node { font-size: 12.5px; }
  .row {
    display: flex; align-items: baseline; gap: 7px; width: 100%; text-align: left;
    background: transparent; border: 0; padding: 3px 6px; border-radius: 6px; cursor: pointer;
    font: inherit; color: var(--fg); transition: background .1s;
  }
  .row:hover:not(:disabled) { background: var(--rowhover); }
  .branch:disabled { cursor: default; }
  .tw { display: inline-flex; width: 12px; flex: 0 0 12px; color: var(--muted); font-size: 9px; justify-content: center; }
  .tw .dot { opacity: .4; }
  .asn { font-family: var(--mono); color: var(--link); font-weight: 700; }
  .setn { font-family: var(--mono); color: var(--fg); font-weight: 700; }
  .branch .setn { color: var(--accent); }
  .nm { color: var(--muted); }
  .src { font: 600 9px var(--sans); color: var(--muted); background: var(--alt); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; letter-spacing: .03em; }
  .src.unr { color: var(--bad, #ef4444); }
  .cyc-m { color: #f59e0b; font-weight: 700; }
  .kids { margin-left: 13px; border-left: 1px solid var(--line2); padding-left: 4px; }
  .empty { color: var(--muted); font-size: 11px; padding: 3px 6px; }
</style>
