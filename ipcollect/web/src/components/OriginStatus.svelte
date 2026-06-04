<script>
  // RPKI ROA + IRR route 状态徽章(给定数值码渲染)。参照 bgp.he.net/bgp.tools:
  //   RPKI: Valid=绿 / Invalid=红(分 ASN 不符 / 长度超 maxLength, 见 tooltip) / NotFound=中性(非错误)。
  //   IRR : present=中性 / mismatch=琥珀(对象登记给了别的 origin) / not-found=中性。
  // 码(与后端 rpki.py/irr.py 一致): rpki 0=NotFound 1=Valid 2=Invalid(ASN) 3=Invalid(len); irr 0=not-found 1=present 2=mismatch。
  // unknown=true 时也显示 NotFound/未登记的中性态(详情面板用); 列表用 false 只显示有信息的状态。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { iShield } from '../lib/icons.js'

  let { rpki = 0, irr = 0, unknown = false } = $props()
  let rp = $derived(Number(rpki) || 0)
  let ir = $derived(Number(irr) || 0)
</script>

{#if S.meta?.has_rpki && (rp || unknown)}
  {#if rp === 1}
    <span class="badge b-ok st" title={t('rpki_valid')}><Fa icon={iShield} /> RPKI</span>
  {:else if rp === 2}
    <span class="badge b-bad st" title={t('rpki_inv_asn')}><Fa icon={iShield} /> RPKI ✗</span>
  {:else if rp === 3}
    <span class="badge b-bad st" title={t('rpki_inv_len')}><Fa icon={iShield} /> RPKI ✗</span>
  {:else if unknown}
    <span class="badge b-mute st" title={t('rpki_notfound')}><Fa icon={iShield} /> RPKI ?</span>
  {/if}
{/if}
{#if S.meta?.has_irr && (ir || unknown)}
  {#if ir === 1}
    <span class="badge b-mute st" title={t('irr_present')}>IRR</span>
  {:else if ir === 2}
    <span class="badge b-warn st" title={t('irr_mismatch')}>IRR ≠</span>
  {:else if unknown}
    <span class="badge b-mute st" title={t('irr_notfound')}>IRR —</span>
  {/if}
{/if}

<style>
  .st { font-size: 9.5px; padding: 0 5px; margin-left: 5px; cursor: help; vertical-align: middle; }
</style>
