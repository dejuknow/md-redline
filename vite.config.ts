import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { HmrContext, Plugin, ViteDevServer } from 'vite';

const serverPort = Number.parseInt(process.env.MD_REDLINE_VITE_PORT ?? '5188', 10);
const apiPort = Number.parseInt(process.env.MD_REDLINE_PORT ?? process.env.PORT ?? '6373', 10);

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
      server.middlewares.use(
        (req: { url?: string }, res: { end: (body: string) => void }, next: () => void) => {
          if (req.url === '/__mdr__') {
            res.end('mdr');
            return;
          }
          next();
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ignoreMarkdownHotUpdatePlugin(), mdrIdentityPlugin()],
  test: {
    // Exclude nested checkouts so vitest doesn't pick up their e2e specs
    // (e.g. <worktree>/e2e/foo.spec.ts) and try to run them as unit tests.
    // Two locations in practice: .worktrees/ for hand-made worktrees, and
    // .claude/worktrees/ for the ones Claude Code creates. Without the second,
    // a worktree left behind by another session adds ~70 failing "test files"
    // to every local run. demo/ contains a Playwright spec too.
    exclude: ['e2e/**', 'demo/**', 'node_modules/**', '.worktrees/**', '.claude/**'],
  },
  server: {
    // Bind IPv4 loopback explicitly so the CLI's 127.0.0.1 probe of
    // /__mdr__ always reaches us regardless of how localhost resolves.
    host: '127.0.0.1',
    port: serverPort,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
    watch: {
      ignored: ['**/*.md'],
    },
  },
});
