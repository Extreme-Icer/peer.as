import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// base './' -> 资源用相对路径, 部署到任意根/子路径都能跑(可镜像)。
// envDir 指向仓库根: 与 CLOUDFLARE_* 同住一个 .env(gitignore)。Vite 只把 `VITE_` 前缀
// 暴露进 bundle, 故根 .env 里的凭据不会泄漏; 仅 VITE_DATA_BASE(数据宿主, 如 R2) 进前端。
export default defineConfig({
  base: './',
  envDir: '../../',
  plugins: [svelte()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, assetsInlineLimit: 2048 },
})
