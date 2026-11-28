import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { rtcBootstrapPlugin } from './scripts/rtcBootstrapPlugin.ts'

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
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          // Keep startup modules together; Mermaid stays dynamically loaded.
          groups: [{ name: 'initial', tags: ['$initial'] }],
        },
      },
    },
    ...(mode === 'profile' ? { outDir: '../../tmp/runtime-diagnostics/profile-web' } : {}),
    ...(mode === 'gateway-share' ? { outDir: 'dist-gateway-share', assetsDir: '' } : {}),
  },
  plugins: [react(),rtcBootstrapPlugin()],
  resolve: {
    dedupe: ['react','react-dom','react-router-dom'],
    alias: {
      ...(mode === 'profile' ? { 'react-dom/client': 'react-dom/profiling' } : {}),
      // The browser entry creates a DOM element; worker parsing needs the pure decoder.
      'decode-named-character-reference': createRequire(import.meta.url).resolve('decode-named-character-reference'),
      '@workstep/gateway-ui/SearchableSelect': fileURLToPath(new URL('../../packages/gateway-ui/src/SearchableSelect.tsx', import.meta.url)) },
  },
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
