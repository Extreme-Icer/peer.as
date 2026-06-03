<script>
  // DNS 解析视图(主内容区, mode==='dns')。左侧列出全部记录:
  //  - A / AAAA: 各自一个 tablewrap(带小标题), 每行 = 地址 + 库内前缀 + origin ASN(可下钻) + TTL。
  //  - 其它类型(NS/MX/TXT/SOA/CNAME/CAA…): 直接分组列出 name/value/TTL。
  // 右侧域名详情面板(DomainDetail)由 detailKind==='domain' 渲染, 逻辑同 ASN 面板。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { showInsight, showDomain } from '../lib/queries.js'
  import { iGlobal, iSpinner, iDb } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'

  let d = $derived(S.dns)
  // 桌面端点击记录可下钻; 移动端域名详情是全屏面板, 先点 IP/ASN 下钻同样可行。
  function openPrefix(rec) { if (rec.pid != null) showInsight(rec.pid, rec.prefix) }
</script>

{#if d}
  <div class="dns">
    <h2><Fa icon={iGlobal} /> {d.domain}
      <button class="whoislink" onclick={() => showDomain(d.domain)}>{t('domain_title')} →</button>
    </h2>

    {#if d.loading}
      <div class="dstat"><Fa icon={iSpinner} spin /> {t('dns_loading')}</div>
    {:else if d.error}
      <div class="dstat err">{t('dns_failed')}: {d.error}</div>
    {:else if d.status === 3}
      <div class="dstat">{t('dns_nxdomain')}</div>
    {:else}
      {#if !d.a?.length && !d.aaaa?.length && !d.others?.length}
        <div class="dstat">{t('dns_none')}</div>
      {/if}

      <!-- A / AAAA: 带前缀 + origin ASN 富集的表 -->
      {#each [['A', d.a, false], ['AAAA', d.aaaa, true]] as [ty, recs]}
        {#if recs?.length}
          <h3 class="rsec">{ty === 'A' ? t('dns_a') : t('dns_aaaa')} <span class="rn">{recs.length}</span></h3>
          <div class="tablewrap">
            <table>
              <thead><tr>
                <th>{t('dns_col_ip')}</th><th>{t('dns_col_prefix')}</th>
                <th>{t('dns_col_asn')}</th><th class="num">{t('dns_col_ttl')}</th>
              </tr></thead>
              <tbody>
                {#each recs as rec}
                  <tr class="rrow" class:link={rec.pid != null} onclick={() => openPrefix(rec)}>
                    <td class="ip">{rec.data}</td>
                    <td class="pfx">{#if rec.prefix}{rec.prefix}{:else}<span class="muted">{t('dns_no_prefix')}</span>{/if}</td>
                    <td>{#if rec.asn != null}<AsnTag asn={rec.asn} />{:else}<span class="muted">—</span>{/if}</td>
                    <td class="num ttl">{rec.ttl}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/each}

      <!-- 其它记录类型: 直接展示 -->
      {#each d.others || [] as grp}
        <h3 class="rsec">{grp.type} <span class="rn">{grp.records.length}</span></h3>
        <div class="rlist">
          {#each grp.records as rec}
            <div class="rline"><span class="rval">{rec.data}</span><span class="rttl">TTL {rec.ttl}</span></div>
          {/each}
        </div>
      {/each}

      <div class="dsrc"><Fa icon={iDb} /> {t('dns_src')}</div>
    {/if}
  </div>
{/if}

<style>
  .dns { padding: 8px 2px 24px; }
  h2 { font: 600 16px var(--mono); margin: 4px 0 14px; color: var(--fg); display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  h2 :global(svg) { color: var(--accent); width: 15px; }
  .whoislink { background: transparent; border: 0; cursor: pointer; color: var(--link); font: 600 11.5px var(--sans); padding: 0; }
  .whoislink:hover { text-decoration: underline; }
  .dstat { color: var(--muted); font-size: 13px; padding: 24px 4px; display: flex; align-items: center; gap: 9px; }
  .dstat.err { color: var(--bad, #dc2626); }
  .rsec {
    font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent);
    margin: 22px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 8px;
  }
  .rsec .rn { font: 600 10px var(--mono); color: var(--muted); background: var(--alt); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 11px; border-bottom: 1px solid var(--line2); white-space: nowrap; }
  thead th { background: var(--alt); color: var(--muted); font: 700 10.5px var(--sans); letter-spacing: .04em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
  th.num, td.num { text-align: right; }
  tbody tr.link { cursor: pointer; }
  tbody tr.link:hover { background: var(--rowhover); }
  td.ip { font-family: var(--mono); color: var(--fg); }
  td.pfx { font-family: var(--mono); color: var(--link); }
  td.ttl { color: var(--muted); font-family: var(--mono); }
  .muted { color: var(--muted); }
  .rlist { display: flex; flex-direction: column; gap: 2px; }
  .rline {
    display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
    padding: 5px 9px; border-bottom: 1px solid var(--line2);
  }
  .rval { font: 12px var(--mono); color: var(--fg); word-break: break-all; }
  .rttl { font: 10.5px var(--mono); color: var(--muted); white-space: nowrap; }
  .dsrc { font-size: 10.5px; color: var(--muted); margin-top: 22px; display: flex; align-items: center; gap: 6px; opacity: .8; }
  .dsrc :global(svg) { width: 10px; }
</style>
