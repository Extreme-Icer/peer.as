<script>
  import { truncToTier1, opOf, opCls, asnName, TIER1 } from '../lib/bgp.js'
  import { showAsn } from '../lib/queries.js'
  let { rec } = $props()
  const go = asn => showAsn(asn)
  const goKey = (e, asn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAsn(asn) } }

  const NW = 120, NH = 34, COLG = 56, ROWG = 14
  function bezier(x1, y1, x2, y2, cls, sw) {
    const mx = ((x1 + x2) / 2).toFixed(1)
    return { d: `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx},${y1.toFixed(1)} ${mx},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, cls, sw }
  }
  function compute(rec) {
    // 路由图**只画经过 Tier-1 的路径**: 有些 path 经 IXP 收来、不过 Tier-1, 否则其末端(非 Tier-1)
    // 会被并排画在 Tier-1 列, 误导。我们只关心 上游→Tier-1, 故把无 Tier-1 的路径整条剔除。
    // (注: 全部去重路径表仍展示所有路径, 只有这张图过滤。)
    const raw = (rec?.paths || []).filter(p => p.asns && p.asns.length && p.asns.some(a => TIER1.has(a)))
    if (!raw.length) return null
    const origin = rec.origin_asn || raw[0].asns[raw[0].asns.length - 1]
    const depth = {}, edgeW = {}, nodes = new Set()
    for (const p of raw) {
      const a = truncToTier1(p.asns), n = a.length, w = p.peers || 1
      for (let i = 0; i < n; i++) { nodes.add(a[i]); const d = n - 1 - i; if (depth[a[i]] == null || d < depth[a[i]]) depth[a[i]] = d }
      for (let i = 0; i < n - 1; i++) { const k = a[i] + '>' + a[i + 1]; edgeW[k] = (edgeW[k] || 0) + w }
    }
    const arr = [...nodes], maxD = Math.max(0, ...arr.map(x => depth[x])), layers = {}
    arr.forEach(x => { (layers[depth[x]] = layers[depth[x]] || []).push(x) })
    Object.values(layers).forEach(l => l.sort((p, q) => (opOf(p) + p).localeCompare(opOf(q) + q)))
    const rowP = NH + ROWG, colP = NW + COLG
    const maxRows = Math.max(1, ...Object.values(layers).map(l => l.length))
    // 不再画 prefix 节点: origin(depth0) 直接放在第 0 列, 图就是 origin -> 上游 -> Tier-1。
    const cols = maxD + 1, W = cols * colP + COLG, H = Math.max(maxRows, 1) * rowP + ROWG
    const cx = col => COLG + col * colP + NW / 2, pos = {}
    for (const d in layers) { const l = layers[d], y0 = (H - l.length * rowP) / 2, x = cx(+d); l.forEach((asn, j) => { pos[asn] = { x, y: y0 + j * rowP + NH / 2 } }) }
    const edges = []
    for (const k in edgeW) {
      const [a, b] = k.split('>').map(Number), pa = pos[a], pb = pos[b]
      if (!pa || !pb) continue
      const sw = Math.min(4.5, 1 + Math.log2(edgeW[k] + 1) / 2)
      edges.push(bezier(pa.x - NW / 2, pa.y, pb.x + NW / 2, pb.y, 'gedge', sw))
    }
    const boxes = arr.map(asn => ({
      x: pos[asn].x, y: pos[asn].y, asn, origin: asn === origin,
      t1: TIER1.has(asn), name: asnName(asn), cls: opCls(asn),
    }))
    return { W, H, edges, boxes }
  }
  let g = $derived(compute(rec))
</script>

{#if g}
  <div class="graphwrap">
    <svg viewBox="0 0 {g.W} {g.H}" width={g.W} height={g.H} class="pathsvg">
      {#each g.edges as e}<path d={e.d} class={e.cls} stroke-width={e.sw} fill="none" />{/each}
      {#each g.boxes as b}
        <g class="gnode nav {b.cls}" class:origin={b.origin} class:tier1={b.t1}
          role="button" tabindex="0" aria-label="AS{b.asn}"
          onclick={() => go(b.asn)} onkeydown={(e) => goKey(e, b.asn)}>
          <rect x={b.x - NW / 2} y={b.y - NH / 2} width={NW} height={NH} rx="5" />
          <text x={b.x} y={b.y - 3} class="gas">AS{b.asn}{b.t1 ? ' ★' : ''}</text>
          {#if b.name}<text x={b.x} y={b.y + 10} class="gnm">{b.name.slice(0, 15)}</text>{/if}
        </g>
      {/each}
    </svg>
  </div>
{/if}

<style>
  .graphwrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--alt); padding: 6px; }
  .pathsvg { display: block; max-width: none; }
  :global(.gedge) { stroke: var(--muted); opacity: .4; fill: none; }
  :global(.gmain) { stroke: var(--accent); opacity: .8; }
  .gnode rect { fill: var(--bg); stroke: var(--c, var(--muted)); stroke-width: 1.4; }
  .gnode.nav { cursor: pointer; }
  .gnode.nav:hover rect { stroke: var(--accent); stroke-width: 2.2; }
  .gnode.nav:focus-visible { outline: none; }
  .gnode.nav:focus-visible rect { stroke: var(--accent); stroke-width: 2.6; }
  .gnode :global(.gas) { font: 700 11px var(--mono); fill: var(--c, var(--fg)); text-anchor: middle; dominant-baseline: middle; }
  .gnode :global(.gnm) { font: 10px var(--sans); fill: var(--muted); text-anchor: middle; }
  .gnode.tier1 rect { stroke-width: 2.6; }
  .gnode.origin rect { fill: color-mix(in srgb, var(--accent) 14%, var(--bg)); stroke: var(--accent); stroke-width: 2; }
  .gnode.gprefix rect { fill: var(--accent); stroke: var(--accent); }
  .gnode.gprefix :global(.gas) { fill: var(--accent-fg); }
</style>
