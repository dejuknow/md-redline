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
    // Exclude .worktrees/** so vitest doesn't pick up nested e2e specs from
    // sibling git worktrees (e.g. .worktrees/<feature>/e2e/foo.spec.ts) and
    // try to run them as unit tests. demo/ contains a Playwright spec too.
    exclude: ['e2e/**', 'demo/**', 'node_modules/**', '.worktrees/**'],
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
