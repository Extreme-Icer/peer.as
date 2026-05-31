import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// base './' -> 资源用相对路径, 部署到任意根/子路径都能跑(可镜像)。
export default defineConfig({
  base: './',
  plugins: [svelte()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, assetsInlineLimit: 2048 },
})
