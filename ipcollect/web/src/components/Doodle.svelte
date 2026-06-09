<script>
  // 首页 hero: 3D 地球 doodle。包一层 canvas + tooltip, 逻辑在 lib/globe.js。
  import { onMount } from 'svelte'
  import { createGlobe } from '../lib/globe.js'

  // origin: {asn?,ip,lat,lon,line1,line2}|null ; route: {asns,entries,adj}|null ; loading: bool
  // onpointer: (clientX, clientY) => void —— 指针在 canvas 上时转发位置(供背景立体字视差用)
  let { origin = null, route = null, loading = false, onpick = null, onpointer = null } = $props()

  let canvasEl, hitEl, tipEl, ctrl
  onMount(() => {
    ctrl = createGlobe(canvasEl, { tip: tipEl, hit: hitEl, onpick, onpointer })
    return () => ctrl?.destroy()
  })
  // 推送 props 变化(起点 / 路由图 / 加载态)到引擎
  $effect(() => { ctrl?.setData(origin, route, loading) })
</script>

<div class="doodle">
  <canvas bind:this={canvasEl}></canvas>
  <!-- 命中层(透明): 接收拖动/点击; WhoisView 把它裁成圆, 圆外的指针穿透到下方查询框, 画布不裁→标注不丢 -->
  <div class="dg-hit" bind:this={hitEl}></div>
  <div class="dg-tip" bind:this={tipEl}><div class="dg-asn"></div><div class="dg-nm"></div></div>
</div>

<style>
  .doodle { position: relative; width: 100%; height: 100%; touch-action: none; }
  .doodle canvas { display: block; width: 100%; height: 100%; position: relative; z-index: 1; pointer-events: none; }
  /* 命中层覆盖整块; 光标态(grab/pointer)挂在这层。裁剪由使用方(WhoisView)套上, Doodle 自身不裁。 */
  .doodle .dg-hit { position: absolute; inset: 0; z-index: 2; cursor: grab; }
  .doodle .dg-hit.hot { cursor: pointer; }
  .doodle .dg-hit.grabbing { cursor: grabbing; }

  .dg-tip {
    position: absolute; left: 0; top: 0; transform: translate(-50%, -130%);
    pointer-events: none; opacity: 0; transition: opacity .14s ease; z-index: 5;
    background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 7px;
    padding: 5px 9px; white-space: nowrap;
    box-shadow: 0 6px 22px -10px rgba(0,0,0,.4);
  }
  .dg-tip:global(.on) { opacity: 1; }
  .dg-tip .dg-asn { font: 600 11px var(--mono); color: var(--accent); }
  .dg-tip .dg-nm { font: 500 11px var(--sans); color: var(--muted); margin-top: 3px; }
  .dg-tip::after {
    content: ''; position: absolute; left: 50%; bottom: -5px; width: 9px; height: 9px;
    background: var(--panel); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
    transform: translateX(-50%) rotate(45deg);
  }
</style>
