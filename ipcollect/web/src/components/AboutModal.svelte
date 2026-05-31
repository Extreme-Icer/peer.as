<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { iClose } from '../lib/icons.js'
  const close = () => (S.about = false)
</script>

{#if S.about}
  <div class="modal" onclick={(e) => e.target === e.currentTarget && close()} role="presentation">
    <div class="modal-box">
      <button class="close" onclick={close} aria-label="close"><Fa icon={iClose} /></button>
      <h2>PEER.AS · 关于 / About</h2>
      <p><b>PEER.AS</b> — 从公开 BGP 数据出发的 <b>BGP / IP / ASN 信息洞察</b>：按国家/城市浏览 IPv4 前缀的路由
        <b>AS_PATH</b>、origin、最优路径与父子段（境内运营商有额外标注）。<br>
        BGP / IP / ASN insights from public data — browse prefixes' <b>AS_PATH</b>, origins and routing by country/city.</p>
      <h3>数据来源 / Data</h3>
      <ul>
        <li><b>路由 / Routing</b>：RIPE RIS <code>rrc00</code> MRT RIB 全表——每个 peer 视角的「去往目标前缀的去程 AS_PATH」。</li>
        <li><b>地理 / Geo</b>：IP 地理库；城市以地理库为准，大段按地理切成子段。</li>
        <li><b>引擎 / Engine</b>：DuckDB-WASM 在浏览器里对静态 Parquet 发 HTTP Range 查询，<b>无后端</b>。</li>
      </ul>
      <h3>分析方法 / Method</h3>
      <ul>
        <li>只看 <b>AS_PATH</b>：有哪些 ASN + 顺序/相邻（<code>1299 23764 4809</code> ≠ <code>1299 4809</code>）。</li>
        <li><b>不做任何「线路质量」评分</b>：CN2 vs GIA 从公网回程 BGP 根本分不出。No line-quality scoring.</li>
        <li>父子段、最优路径等仅基于已采集的全球 v4 前缀，可能不全。</li>
      </ul>
      <p class="disc"><b>免责 / Disclaimer</b>：仅供学习与研究 BGP 路由；数据为公开 collector 的近似快照，可能过时。
        For BGP research/education only; approximate public snapshot.</p>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(2, 6, 14, .62); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px; overflow: auto; z-index: 50; animation: fade .15s ease; }
  @keyframes fade { from { opacity: 0 } }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 660px; width: 100%; padding: 24px 28px; box-shadow: 0 24px 70px rgba(0, 0, 0, .5); position: relative; }
  .close { position: absolute; top: 16px; right: 18px; background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 18px; }
  .close:hover { color: var(--accent); }
  h2 { font: 600 16px var(--sans); margin: 0 0 12px; }
  h3 { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 18px 0 6px; }
  p { font-size: 12.5px; line-height: 1.75; margin: 6px 0; color: var(--fg); }
  b { font-weight: 600; }
  code { font: 11.5px var(--mono); color: var(--code); }
  ul { margin: 4px 0; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.7; margin: 4px 0; }
  .disc { color: var(--muted); font-size: 12px; border-top: 1px solid var(--line2); margin-top: 16px; padding-top: 13px; }
</style>
