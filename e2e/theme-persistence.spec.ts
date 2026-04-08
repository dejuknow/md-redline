import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

async function selectThemeViaCommandPalette(page: Page, themeName: string) {
  await page.keyboard.press(withMod('k'));
  await page.getByPlaceholder('Type a command...').fill(`Theme: ${themeName}`);
  await page.keyboard.press('Enter');
  // Wait for palette to close
  await expect(page.getByPlaceholder('Type a command...')).not.toBeVisible();
}

// ---------------------------------------------------------------------------
// Theme switching and visual verification
// ---------------------------------------------------------------------------

test.describe('Theme switching', () => {
  test('switching to Dark theme sets data-theme attribute', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Dark');
    await expect(page.locator('[data-theme="dark"]')).toBeVisible();
  });

  test('switching to Nord theme sets data-theme attribute', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Nord');
    await expect(page.locator('[data-theme="nord"]')).toBeVisible();
  });

  test('switching to Sepia theme sets data-theme attribute', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Sepia');
    await expect(page.locator('[data-theme="sepia"]')).toBeVisible();
  });

  test('switching from Dark back to Light changes data-theme', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Dark');
    await expect(page.locator('[data-theme="dark"]')).toBeVisible();

    await selectThemeViaCommandPalette(page, 'Light');
    await expect(page.locator('[data-theme="light"]')).toBeVisible();
    await expect(page.locator('[data-theme="dark"]')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Theme persistence across page reload
// ---------------------------------------------------------------------------

test.describe('Theme persistence', () => {
  test('selected theme persists after page reload', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Nord');
    await expect(page.locator('[data-theme="nord"]')).toBeVisible();

    // Allow save to flush
    await page.waitForTimeout(500);

    // Reload
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await expect(page.locator('[data-theme="nord"]')).toBeVisible();
  });

  test('switching themes multiple times persists the last one', async ({ page }) => {
    await openFixture(page);

    await selectThemeViaCommandPalette(page, 'Dark');
    await expect(page.locator('[data-theme="dark"]')).toBeVisible();

    await selectThemeViaCommandPalette(page, 'Catppuccin');
    await expect(page.locator('[data-theme="catppuccin"]')).toBeVisible();

    await selectThemeViaCommandPalette(page, 'Sepia');
    await expect(page.locator('[data-theme="sepia"]')).toBeVisible();

    await page.waitForTimeout(500);
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await expect(page.locator('[data-theme="sepia"]')).toBeVisible();
  });

  test('theme persists when navigating to a new file', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Rosé Pine');
    await expect(page.locator('[data-theme="rose-pine"]')).toBeVisible();

    // Navigate to homepage and back
    await page.goto('/');
    await page.waitForTimeout(300);

    await expect(page.locator('[data-theme="rose-pine"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Theme affects visual styling
// ---------------------------------------------------------------------------

test.describe('Theme visual changes', () => {
  test('dark theme changes background color to dark', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Dark');

    // Verify the page body or main container has a dark background
    const bgColor = await page.evaluate(() => {
      const el = document.querySelector('[data-theme="dark"]');
      return el ? getComputedStyle(el).backgroundColor : '';
    });

    // Dark themes should have an RGB background that's not white
    expect(bgColor).not.toBe('rgb(255, 255, 255)');
  });

  test('light theme has a light background', async ({ page }) => {
    await openFixture(page);
    await selectThemeViaCommandPalette(page, 'Light');

    const bgColor = await page.evaluate(() => {
      const el = document.querySelector('[data-theme="light"]');
      return el ? getComputedStyle(el).backgroundColor : '';
    });

    // Light theme background should be white or near-white
    // Just verify it's not dark (r,g,b each > 200)
    const match = bgColor.match(/rgb\((\d+), (\d+), (\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      expect(r).toBeGreaterThan(200);
      expect(g).toBeGreaterThan(200);
      expect(b).toBeGreaterThan(200);
    }
  });
});
