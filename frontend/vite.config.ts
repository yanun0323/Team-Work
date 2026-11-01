import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// the backend, unless running on the simulator (`--mode mock`); ws for its stream of changes
const BACKEND = { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, ws: true } }

export default defineConfig({
  plugins: [react()],
  // `..` for the built-in blueprints and flows, whose text the backend shares
  server: { port: 5173, strictPort: true, proxy: BACKEND, fs: { allow: ['..'] } },
  preview: { port: 5173, strictPort: true, proxy: BACKEND },
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
})
