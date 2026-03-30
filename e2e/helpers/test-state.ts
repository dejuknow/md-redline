import type { Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const e2eHomeDir = resolve(repoRoot, '.playwright-home');
const prefsFile = resolve(e2eHomeDir, '.md-redline.json');

export async function resetTestAppState(page: Page) {
  mkdirSync(e2eHomeDir, { recursive: true });
  rmSync(prefsFile, { force: true });
  await page.goto('/');
}
