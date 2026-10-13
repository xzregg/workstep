import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep classic media queries for older Android WebViews, as in apps/web.
    cssTarget: ['chrome80', 'safari13'],
  },
  resolve: { dedupe: ['react','react-dom','react-router-dom'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8766' } },
})
