<script>
  import Fa from 'svelte-fa'
  import { tw } from '../lib/i18n.js'
  import { iChevR, iChevD } from '../lib/icons.js'
  import { roleIcon } from '../lib/whois-fields.js'
  import WhoisRow from './WhoisRow.svelte'
  import WhoisEntity from './WhoisEntity.svelte'   // 自导入: 递归渲染嵌套 entity
  let { entity, depth = 0 } = $props()
  // entity 默认收起成一行(角色 + 名称), 点击展开。abuse 实体可视为更重要 -> 仍默认收起, 但样式高亮。
  let open = $state(false)
  let kind = $derived(entity.rows?.find(r => r.key === 'kind')?.value)
  let roleTxt = $derived((entity.roles || []).map(r => tw('role_', r)).join(' · '))
  let abuse = $derived((entity.roles || []).includes('abuse'))
  let hasBody = $derived(((entity.rows?.length || 0) + (entity.entities?.length || 0)) > 0)
</script>

<div class="went" class:abuse>
  <button class="whead" onclick={() => hasBody && (open = !open)} disabled={!hasBody} aria-expanded={open}>
    <span class="chev">{#if hasBody}<Fa icon={open ? iChevD : iChevR} />{/if}</span>
    <span class="ri"><Fa icon={roleIcon(entity.roles, kind)} /></span>
    {#if roleTxt}<span class="rt" class:abuse>{roleTxt}</span>{/if}
    <span class="rn">{entity.name}</span>
  </button>
  {#if open}
    <div class="wbody">
      {#each entity.rows || [] as r}
        {#if r.key !== 'kind'}<WhoisRow rowKey={r.key} value={r.value} />{/if}
      {/each}
      {#each entity.entities || [] as sub}
        <WhoisEntity entity={sub} depth={depth + 1} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* 嵌套 entity: 左侧 tree-guide 竖线 + 缩进一档, 体现层级但不喧宾夺主。 */
  .went { border-left: 1px solid var(--line2); margin: 2px 0 2px 2px; }
  .whead {
    display: flex; align-items: baseline; gap: 7px; width: 100%; text-align: left;
    background: transparent; border: 0; cursor: pointer; padding: 3px 6px 3px 8px;
    font: 12px var(--sans); color: var(--fg); border-radius: 5px;
  }
  .whead:hover:not(:disabled) { background: var(--line2); }
  .whead:disabled { cursor: default; }
  .chev { flex: 0 0 9px; }
  .chev :global(svg) { width: 9px; color: var(--muted); }
  .ri :global(svg) { width: 11px; color: var(--muted); position: relative; top: 1px; }
  .went.abuse .ri :global(svg) { color: var(--signal); }
  .rt {
    font: 700 10px var(--sans); letter-spacing: .03em; text-transform: uppercase;
    color: var(--accent); white-space: nowrap;
  }
  .rt.abuse { color: var(--signal); }
  .rn { font-family: var(--mono); color: var(--fg); word-break: break-word; min-width: 0; }
  .wbody { padding: 1px 0 3px 18px; }
</style>
