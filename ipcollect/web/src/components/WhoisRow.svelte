<script>
  import Fa from 'svelte-fa'
  import { tw } from '../lib/i18n.js'
  import { keyIcon } from '../lib/whois-fields.js'
  let { rowKey, value } = $props()
  let icon = $derived(keyIcon(rowKey))
  let label = $derived(tw('w_', rowKey))
  // 邮箱可点 mailto; URL 可点开
  let isMail = $derived(rowKey === 'email')
  let isUrl = $derived(rowKey === 'url' && /^https?:\/\//.test(value))
</script>

<div class="wrow">
  <span class="wk"><Fa icon={icon} /> <span class="wkl">{label}</span></span>
  {#if isMail}
    <a class="wv link" href={`mailto:${value}`}>{value}</a>
  {:else if isUrl}
    <a class="wv link" href={value} target="_blank" rel="noopener noreferrer">{value}</a>
  {:else}
    <span class="wv">{value}</span>
  {/if}
</div>

<style>
  /* 一行一个 key:value, 模仿扁平 whois。窄屏(抽屉)下 key 列固定窄、value 占满, 必要时换行。 */
  .wrow { display: grid; grid-template-columns: 116px 1fr; gap: 4px 10px; padding: 1.5px 0; font-size: 12px; line-height: 1.55; align-items: baseline; }
  .wk { color: var(--muted); display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; }
  .wk :global(svg) { width: 11px; color: var(--muted); opacity: .85; flex: 0 0 auto; position: relative; top: 1px; }
  .wkl { overflow: hidden; text-overflow: ellipsis; }
  .wv { font-family: var(--mono); color: var(--fg); word-break: break-word; min-width: 0; }
  .wv.link { color: var(--link); text-decoration: none; }
  .wv.link:hover { text-decoration: underline; }
  @media (max-width: 520px) {
    .wrow { grid-template-columns: 92px 1fr; font-size: 11.5px; }
  }
</style>
