import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MOD_LABEL } from './helpers/shortcuts';

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

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// File explorer tests
// ---------------------------------------------------------------------------

/** Toggle explorer via the toolbar button. */
const explorerToggle = (page: Page) =>
  page.locator(`button[title="Toggle file explorer (${MOD_LABEL}+B)"]`);

async function toggleExplorer(page: Page) {
  await explorerToggle(page).click();
}

/** The toolbar button gets bg-primary-bg when explorer is open. Check that class. */
async function isExplorerOpen(page: Page) {
  const cls = await explorerToggle(page).getAttribute('class') ?? '';
  return cls.includes('bg-primary-bg');
}

async function ensureExplorerVisible(page: Page) {
  if (!(await isExplorerOpen(page))) {
    await toggleExplorer(page);
    // Wait for the file listing to load inside the panel
    await page.waitForTimeout(300);
  }
}

test.describe('File explorer', () => {
  test('toolbar button toggles file explorer visibility', async ({ page }) => {
    await openFixture(page);

    await ensureExplorerVisible(page);
    expect(await isExplorerOpen(page)).toBe(true);

    // Toggle off
    await toggleExplorer(page);
    expect(await isExplorerOpen(page)).toBe(false);

    // Toggle on
    await toggleExplorer(page);
    expect(await isExplorerOpen(page)).toBe(true);
  });

  test('explorer shows directories and markdown files', async ({ page }) => {
    // Open with dir param to ensure explorer shows fixtures directory
    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    // Ensure explorer is visible
    await ensureExplorerVisible(page);

    // The explorer should list markdown files in its current directory
    // It should show at least one .md file
    const fileButtons = page.locator('button[title]').filter({ hasText: '.md' });
    const count = await fileButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('clicking a file in explorer opens it', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await ensureExplorerVisible(page);

    // Navigate into e2e/ then fixtures/ from the project root
    await page.locator('button', { hasText: 'e2e' }).click();
    await expect(page.locator('button', { hasText: 'fixtures' })).toBeVisible({ timeout: 5000 });
    await page.locator('button', { hasText: 'fixtures' }).click();

    // Click on the test-doc.md file
    await expect(page.locator('button', { hasText: 'test-doc.md' }).first()).toBeVisible({ timeout: 5000 });
    await page.locator('button', { hasText: 'test-doc.md' }).first().click();

    // The file should open and render
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a directory navigates into it', async ({ page }) => {
    await openFixture(page);

    await ensureExplorerVisible(page);

    // Find any directory button (they have folder icons with text-warning class)
    const dirButtons = page.locator('button').filter({
      has: page.locator('svg.text-warning'),
    });
    const dirCount = await dirButtons.count();

    if (dirCount > 0) {
      await dirButtons.first().click();

      // After navigating, the "Go up" button should appear
      await expect(page.locator('button[title="Go up"]')).toBeVisible();
    }
  });

  test('Go up button navigates to parent directory', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await ensureExplorerVisible(page);

    // Navigate into e2e/ directory
    await page.locator('button', { hasText: 'e2e' }).click();
    await expect(page.locator('button', { hasText: 'fixtures' })).toBeVisible({ timeout: 5000 });

    // Navigate into fixtures/
    await page.locator('button', { hasText: 'fixtures' }).click();
    await expect(page.locator('button', { hasText: 'test-doc.md' }).first()).toBeVisible({ timeout: 5000 });

    // Click Go up — should navigate back to e2e/
    await page.locator('button[title="Go up"]').click();
    await expect(page.locator('button', { hasText: 'fixtures' })).toBeVisible({ timeout: 5000 });
  });

  test('close button hides the explorer', async ({ page }) => {
    await openFixture(page);

    await ensureExplorerVisible(page);
    expect(await isExplorerOpen(page)).toBe(true);

    await page.locator('button[title="Close panel"]').click();
    // The toolbar toggle button should lose its active state
    expect(await isExplorerOpen(page)).toBe(false);
  });
});
