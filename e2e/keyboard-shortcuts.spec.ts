import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = readFileSync(FIXTURE, 'utf-8');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

test.describe('keyboard shortcuts', () => {
  test('? opens keyboard shortcuts help panel', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('?');
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+K opens command palette', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press(withMod('k'));
    await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+, opens settings panel', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press(withMod(','));
    await expect(page.locator('text=Settings')).toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+O opens file picker', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press(withMod('o'));
    await expect(page.getByPlaceholder('File path or name...')).toBeVisible({ timeout: 3_000 });
  });
});
