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

/**
 * Drop persisted preferences without needing a page. Specs that change a
 * persisted setting (theme, prose font) should call this in `afterAll`: the
 * prefs file is shared and workers is 1, so whatever they leave behind is what
 * later specs boot into, and not every spec resets in `beforeEach`.
 */
export function clearPersistedPreferences() {
  rmSync(prefsFile, { force: true });
}
