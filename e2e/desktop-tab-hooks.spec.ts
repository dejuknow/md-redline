import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE, TEST_DOC_2_BASELINE } from './helpers/fixture-baselines';
import { addComment } from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

// The desktop shell drives tabs through hooks App sets on window
// (__mdrNewTab, __mdrCloseActiveTab, __mdrReopenClosedTab) and tells the page
// it is the desktop app with window.__mdrDesktop. The browser build sets the
// same hooks, so they are driven here directly, as the shell's eval does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const IS_MAC = process.platform === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl';

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
});

async function asDesktopApp(page: Page) {
  await page.addInitScript(() => {
    window.__mdrDesktop = true;
  });
}

async function openBoth(page: Page) {
  await page.goto(`/?file=${FIXTURE_1}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
  await page.evaluate((path) => window.__mdrOpenTarget?.({ file: path }), FIXTURE_2);
  await expect(
    page.getByRole('button', { name: 'Close test-doc-2.md', exact: true }),
  ).toBeAttached();
}

async function openPalette(page: Page) {
  await page.keyboard.press(withMod('k'));
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 3_000 });
}

function paletteItem(page: Page, label: string) {
  return page.locator('[data-overlay] button', { hasText: label });
}

function tabClose(page: Page, name: string) {
  return page.getByRole('button', { name: `Close ${name}`, exact: true });
}

test.describe('Desktop tab hooks', () => {
  test('__mdrNewTab opens the file picker, as the strip\'s "+" does', async ({ page }) => {
    await openBoth(page);
    await page.evaluate(() => window.__mdrNewTab?.());
    await expect(page.getByPlaceholder('File path or name...')).toBeVisible();
  });

  test('the palette closes and reopens tabs in a browser, without the desktop keys', async ({
    page,
  }) => {
    await openBoth(page);
    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('tab');
    await expect(paletteItem(page, 'New tab')).toBeVisible();
    await expect(paletteItem(page, 'Close tab')).toBeVisible();
    // A browser keeps these keys for its own tabs, so no key is shown.
    await expect(paletteItem(page, 'New tab').locator('kbd')).toHaveCount(0);
    await expect(paletteItem(page, 'Close tab').locator('kbd')).toHaveCount(0);

    await paletteItem(page, 'Close tab').click();
    await expect(tabClose(page, 'test-doc-2.md')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();

    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('reopen closed');
    await expect(paletteItem(page, 'Reopen closed tab').locator('kbd')).toHaveCount(0);
    await paletteItem(page, 'Reopen closed tab').click();
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();

    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('new tab');
    await paletteItem(page, 'New tab').click();
    await expect(page.getByPlaceholder('File path or name...')).toBeVisible();
  });

  test('inside the desktop app the palette and the ? panel show the tab keys', async ({ page }) => {
    await asDesktopApp(page);
    await openBoth(page);
    await page.evaluate(() => window.__mdrCloseActiveTab?.());
    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('tab');
    await expect(paletteItem(page, 'New tab').locator('kbd')).toHaveText(`${MOD}+T`);
    await expect(paletteItem(page, 'Close tab').locator('kbd')).toHaveText(`${MOD}+W`);
    await expect(paletteItem(page, 'Reopen closed tab').locator('kbd')).toHaveText(
      `${MOD}+Shift+T`,
    );
    await page.keyboard.press('Escape');

    await page.keyboard.press('?');
    const panel = page.locator('h2', { hasText: 'Keyboard Shortcuts' }).locator('../..');
    await expect(panel.getByText('Tabs', { exact: true })).toBeVisible();
    await expect(panel.getByText('New tab', { exact: true })).toBeVisible();
    await expect(panel.getByText('Close tab', { exact: true })).toBeVisible();
    await expect(panel.getByText('Reopen closed tab', { exact: true })).toBeVisible();
  });

  test('the ? panel leaves the tab keys out in a browser', async ({ page }) => {
    await openBoth(page);
    await page.keyboard.press('?');
    const panel = page.locator('h2', { hasText: 'Keyboard Shortcuts' }).locator('../..');
    await expect(panel.getByText('Previous tab', { exact: true })).toBeVisible();
    await expect(panel.getByText('New tab', { exact: true })).toHaveCount(0);
  });
});

test.describe('Desktop Close Tab with an overlay open', () => {
  test('closes the palette, not the document behind it', async ({ page }) => {
    await openBoth(page);
    await openPalette(page);
    expect(await page.evaluate(() => window.__mdrCloseActiveTab?.())).toBe(true);
    await expect(page.getByPlaceholder('Type a command...')).toHaveCount(0);
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();
    // The next press closes the tab.
    expect(await page.evaluate(() => window.__mdrCloseActiveTab?.())).toBe(true);
    await expect(tabClose(page, 'test-doc-2.md')).toHaveCount(0);
  });

  test('closes the settings panel and the shortcuts panel first', async ({ page }) => {
    await openBoth(page);
    await page.keyboard.press(withMod(','));
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.evaluate(() => window.__mdrCloseActiveTab?.());
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();

    await page.keyboard.press('?');
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await page.evaluate(() => window.__mdrCloseActiveTab?.());
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toHaveCount(0);
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();
  });

  test('leaves the unsaved-changes dialog on the tab it asked about', async ({ page }) => {
    await openBoth(page);
    // Make test-doc.md unsaved: its write fails, so the tab stays dirty.
    await page
      .getByRole('button', { name: /^test-doc\.md/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
    await page.route('**/api/file', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, body: '{"error":"disk full"}' })
        : route.continue(),
    );
    await addComment(page, 'valid credentials', 'Unsaved note');
    await page.unroute('**/api/file');

    // Switch to the other tab, then ask to close the dirty one from its x.
    await page
      .getByRole('button', { name: /^test-doc-2\.md/ })
      .first()
      .click();
    await tabClose(page, 'test-doc.md').click({ force: true });
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Unsaved changes');

    // Cmd+W with the dialog up used to point the dialog at the active tab and
    // close that one. Now it waits for the dialog's answer.
    expect(await page.evaluate(() => window.__mdrCloseActiveTab?.())).toBe(true);
    await expect(dialog).toBeVisible();
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();
    // New Tab waits for it too.
    await page.evaluate(() => window.__mdrNewTab?.());
    await expect(page.getByPlaceholder('File path or name...')).toHaveCount(0);

    // The dialog still closes the tab it asked about.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(tabClose(page, 'test-doc.md')).toHaveCount(0);
    await expect(tabClose(page, 'test-doc-2.md')).toBeAttached();
  });
});
