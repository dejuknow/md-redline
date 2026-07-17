import { defineConfig } from '@playwright/test';
import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2eHomeDir = resolve(__dirname, '.playwright-home');
rmSync(e2eHomeDir, { recursive: true, force: true });
mkdirSync(e2eHomeDir, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 30_000,
  use: {
    // 127.0.0.1, not localhost: vite binds IPv4 loopback only, and
    // Playwright's Node-side API client pays a ~300ms ::1-refusal fallback
    // on every localhost request (the browser doesn't). Measured 305ms vs
    // 3ms per request-context call.
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    port: 4173,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      MD_REDLINE_HOME: e2eHomeDir,
      MD_REDLINE_PORT: '3101',
      MD_REDLINE_VITE_PORT: '4173',
    },
  },
});
