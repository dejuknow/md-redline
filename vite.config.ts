import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const serverPort = Number.parseInt(process.env.MD_REDLINE_VITE_PORT ?? '5173', 10);
const apiPort = Number.parseInt(process.env.MD_REDLINE_PORT ?? process.env.PORT ?? '3001', 10);

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
    port: serverPort,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
    watch: {
      ignored: ['**/*.md'],
    },
  },
});
