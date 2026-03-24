import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    exclude: ['e2e/**', 'node_modules/**'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
    watch: {
      ignored: [/\.md$/],
    },
  },
})
