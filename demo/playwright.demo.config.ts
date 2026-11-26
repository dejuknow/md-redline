import { defineConfig } from '@playwright/test';
import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const demoHomeDir = resolve(repoRoot, '.playwright-home');
rmSync(demoHomeDir, { recursive: true, force: true });
mkdirSync(demoHomeDir, { recursive: true });

// Overridable so a recording can run while another checkout's dev server holds
// the defaults. reuseExistingServer would otherwise attach to that server, which
// cannot see this checkout's fixtures and answers 403.
const serverPort = process.env.DEMO_SERVER_PORT ?? '3101';
const vitePort = Number(process.env.DEMO_VITE_PORT ?? '4173');

export default defineConfig({
  testDir: '.',
  testMatch: 'demo.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: {
    baseURL: `http://localhost:${vitePort}`,
    viewport: { width: 1600, height: 1000 },
    video: 'off',
    screenshot: 'off',
    trace: 'off',
  },
  projects: [
    {
      name: 'demo',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    port: vitePort,
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      ...process.env,
      MD_REDLINE_HOME: demoHomeDir,
      MD_REDLINE_PORT: serverPort,
      MD_REDLINE_VITE_PORT: String(vitePort),
    },
  },
});
