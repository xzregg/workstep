import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  ...(mode === 'gateway-share' ? {
    base: '/workspace-assets/',
  } : {}),
  experimental: {
    // Keep entry URLs absolute for deep links; lazy assets follow their module.
    renderBuiltUrl: (_filename: string, { hostType }: { hostType: string }) => ({ relative: hostType !== 'html' }),
  },
  build: {
    // DingTalk and older Android WebViews need classic max-width media queries.
    cssTarget: ['chrome80', 'safari13'],
    ...(mode === 'gateway-share' ? { outDir: 'dist-gateway-share', assetsDir: '' } : {}),
  },
  plugins: [react()],
  resolve: { dedupe: ['react','react-dom','react-router-dom'] },
  server: {
    proxy: {
      // Project-relative upload URLs: {project}/.workstep/uploads/{file}
      // (key starting with '^' is matched as a RegExp by vite)
      '^/.*\\.workstep/uploads': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
      // Preserve the browser origin for platform callbacks and cookie CSRF checks.
      '/gateway/login': {
        target: 'http://localhost:8765',
        changeOrigin: false,
      },
      '/api': {
        target: 'http://localhost:8765',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
    },
  },
}))
