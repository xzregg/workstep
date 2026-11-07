import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep classic media queries for older Android WebViews, as in apps/web.
    cssTarget: ['chrome80', 'safari13'],
  },
  resolve: {
    dedupe: ['react','react-dom','react-router-dom'],
    alias: { '@workstep/gateway-ui/SearchableSelect': fileURLToPath(new URL('../../packages/gateway-ui/src/SearchableSelect.tsx', import.meta.url)) },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8766' } },
})
