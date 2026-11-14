import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { execSync } from 'node:child_process'

// the commit being built, shown after the version in About; empty outside a Git checkout
function commit() {
  try {
    return execSync('git rev-parse --short=6 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

// the backend, unless running on the simulator (`--mode mock`); ws for its stream of changes
const BACKEND = { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, ws: true } }

export default defineConfig({
  plugins: [react()],
  define: { __COMMIT__: JSON.stringify(commit()) },
  // `..` for the built-in blueprints and flows, whose text the backend shares
  server: { port: 5173, strictPort: true, proxy: BACKEND, fs: { allow: ['..'] } },
  preview: { port: 5173, strictPort: true, proxy: BACKEND },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', environment: 'node', include: ['src/**/*.test.{ts,tsx}'], exclude: ['src/**/*.browser.test.{ts,tsx}'] } },
      // what needs real layout, such as scrolling, runs in WebKit, the engine of the macOS app
      { extends: true, test: { name: 'webkit', include: ['src/**/*.browser.test.{ts,tsx}'],
        browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'webkit' }] } } },
    ],
  },
})
