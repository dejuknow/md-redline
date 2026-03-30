import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export function ignoreMarkdownHotUpdatePlugin() {
  return {
    name: 'ignore-markdown-hot-updates',
    handleHotUpdate(ctx: { file: string }) {
      if (ctx.file.toLowerCase().endsWith('.md')) {
        return [];
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ignoreMarkdownHotUpdatePlugin()],
  test: {
    exclude: ['e2e/**', 'node_modules/**'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
    watch: {
      ignored: ['**/*.md'],
    },
  },
});
