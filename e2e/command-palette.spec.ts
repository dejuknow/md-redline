import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = TEST_DOC_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

async function openPalette(page: Page) {
  await page.keyboard.press(withMod('k'));
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 3_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Command palette', () => {
  test('opens with Cmd+K and shows the search input', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('fuzzy search filters commands by label', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    await input.fill('theme');

    // Commands matching "theme" should be visible; unrelated ones should be hidden
    const visibleItems = page.locator('button[data-selected]');
    const count = await visibleItems.count();
    expect(count).toBeGreaterThan(0);

    // Verify at least one item contains "theme" (case-insensitive)
    const texts = await visibleItems.allTextContents();
    const hasTheme = texts.some((t) => t.toLowerCase().includes('theme'));
    expect(hasTheme).toBe(true);
  });

  test('keyboard navigation: arrow down/up moves selection', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    // First item should be selected by default
    const firstItem = page.locator('button[data-selected="true"]').first();
    const firstText = await firstItem.textContent();
    expect(firstText).toBeTruthy();

    // Arrow down moves to next item
    await page.keyboard.press('ArrowDown');
    const secondSelected = page.locator('button[data-selected="true"]').first();
    const secondText = await secondSelected.textContent();
    expect(secondText).not.toBe(firstText);

    // Arrow up moves back
    await page.keyboard.press('ArrowUp');
    const backToFirst = page.locator('button[data-selected="true"]').first();
    const backText = await backToFirst.textContent();
    expect(backText).toBe(firstText);
  });

  test('Enter executes the selected command', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    // Search for "toggle sidebar" — a command that should toggle sidebar visibility
    await input.fill('toggle sidebar');
    await page.waitForTimeout(100);

    const selectedItem = page.locator('button[data-selected="true"]').first();
    await expect(selectedItem).toBeVisible();

    // Press Enter to execute
    await page.keyboard.press('Enter');

    // The palette should close after execution
    await expect(input).not.toBeVisible();
  });

  test('Escape closes the palette', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(input).not.toBeVisible();
  });

  test('"Go to heading" subcommand shows headings from the document', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    // Type a heading name from the fixture
    await input.fill('Section One');
    await page.waitForTimeout(100);

    // Should see a heading entry matching "Section One"
    const headingItem = page.locator('button[data-selected]', { hasText: 'Section One' });
    await expect(headingItem.first()).toBeVisible();
  });

  test('no matching commands shows empty state', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    await input.fill('zzz_nonexistent_command_xyz');
    await page.waitForTimeout(100);

    await expect(page.getByText('No matching commands')).toBeVisible();
  });

  test('clicking outside closes the palette', async ({ page }) => {
    await openFixture(page);
    await openPalette(page);

    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();

    // Click on the backdrop area
    await page
      .locator('.fixed.inset-0')
      .first()
      .click({ position: { x: 10, y: 10 } });
    await expect(input).not.toBeVisible();
  });
});
