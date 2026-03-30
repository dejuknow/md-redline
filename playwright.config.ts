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
    baseURL: 'http://localhost:4173',
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
