import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  ...(mode === 'gateway-share' ? {
    base: '/workspace-assets/', build: { outDir: 'dist-gateway-share', assetsDir: '' },
  } : {}),
  plugins: [react()],
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
