import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { HmrContext, Plugin, ViteDevServer } from 'vite';

const serverPort = Number.parseInt(process.env.MD_REDLINE_VITE_PORT ?? '5188', 10);
const apiPort = Number.parseInt(process.env.MD_REDLINE_PORT ?? process.env.PORT ?? '3001', 10);

export function ignoreMarkdownHotUpdatePlugin(): Plugin {
  return {
    name: 'ignore-markdown-hot-updates',
    handleHotUpdate(ctx: HmrContext) {
      if (ctx.file.toLowerCase().endsWith('.md')) {
        return [];
      }
      return undefined;
    },
  };
}

export function mdrIdentityPlugin(): Plugin {
  return {
    name: 'mdr-identity',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: { url?: string }, res: { end: (body: string) => void }, next: () => void) => {
        if (req.url === '/__mdr__') {
          res.end('mdr');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ignoreMarkdownHotUpdatePlugin(), mdrIdentityPlugin()],
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
