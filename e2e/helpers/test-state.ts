import type { Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const e2eHomeDir = resolve(repoRoot, '.playwright-home');
const prefsFile = resolve(e2eHomeDir, '.md-redline.json');

/**
 * `enableResolve` is pinned rather than left to the shipped default. Specs
 * across this suite were written against remove mode: they click a toggle
 * expecting it to turn resolve ON, or reach for "Delete All", which only
 * renders when resolve is off. Inheriting the product default made a change to
 * that default silently invert a dozen of them. A spec that wants the default
 * should assert it explicitly (see settings-features.spec.ts).
 */
const E2E_BASELINE_PREFS = { settings: { enableResolve: false } };

export async function resetTestAppState(page: Page) {
  mkdirSync(e2eHomeDir, { recursive: true });
  writeFileSync(prefsFile, JSON.stringify(E2E_BASELINE_PREFS), 'utf8');
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
