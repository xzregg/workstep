import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Project-relative upload URLs: {project}/.workstep/uploads/{file}
      // (key starting with '^' is matched as a RegExp by vite)
      '^/.*\\.workstep/uploads': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
    },
  },
})
