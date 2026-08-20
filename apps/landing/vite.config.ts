import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 生产构建可指定子路径（如 LANDING_BASE=/landing/ 由 daemon 在 /landing 托管）；
  // 默认 "/" 保持现有行为不变。
  base: process.env.LANDING_BASE || '/',
  plugins: [react()],
  server: {
    port: 5174,
  },
})
