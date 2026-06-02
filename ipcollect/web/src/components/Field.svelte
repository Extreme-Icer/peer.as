<script>
  import Fa from 'svelte-fa'
  let {
    icon, value = $bindable(''), placeholder = '', list = null,
    disabled = false, width = '170px', big = false, grow = false,
    oninput = () => {}, onenter = () => {},
  } = $props()
</script>

<label class="field" class:big class:grow style:width={width} class:disabled>
  <span class="fi"><Fa {icon} /></span>
  <input
    type="text" {placeholder} {list} {disabled} bind:value
    oninput={oninput}
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onenter() } }} />
</label>

<style>
  .field {
    display: inline-flex; align-items: center; gap: 7px; min-width: 0;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 7px;
    padding: 0 9px; height: 32px; transition: border-color .15s, box-shadow .15s;
  }
  .field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .field.disabled { opacity: 0.5; }
  .field.grow { flex: 1 1 0; }
  .field.big { height: 40px; padding: 0 13px; border-radius: 9px; gap: 9px; }
  .field.big .fi { font-size: 14px; }
  .field.big input { font-size: 14px; }
  .fi { color: var(--muted); font-size: 12px; display: inline-flex; flex: 0 0 auto; }
  .field:focus-within .fi { color: var(--accent); }
  input {
    border: 0; background: transparent; color: var(--fg); font-size: 12.5px;
    font-family: inherit; width: 100%; min-width: 0; padding: 0; outline: none;
  }
  input::placeholder { color: var(--muted); opacity: .8; }
  /* 移动端: 主搜索框(big)字号改回默认, 与其它输入框一致(高度仍保留, 便于触控) */
  @media (max-width: 820px) {
    .field.big input { font-size: 12.5px; }
    .field.big .fi { font-size: 12px; }
  }
</style>
