import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  TEST_DOC_BASELINE,
  TEST_DOC_2_BASELINE,
  TOC_DOC_BASELINE,
} from './helpers/fixture-baselines';
import { addComment, getCard } from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

// The desktop shell's menus and tab keys call hooks App registers on window.
// The browser build registers the same hooks, so they are driven here
// directly, as the shell's eval does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_3 = resolve(__dirname, 'fixtures/toc-doc.md');
// Read only.
const MERMAID_FIXTURE = resolve(__dirname, 'fixtures/mermaid-doc.md');

const HEADING_1 = 'Test Document';
const HEADING_2 = 'Second Test Document';
const HEADING_3 = 'Project Specification';

function restoreFixtures() {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
  writeFileSync(FIXTURE_3, TOC_DOC_BASELINE);
}

test.beforeEach(async ({ page }) => {
  restoreFixtures();
  await resetTestAppState(page);
});

test.afterAll(restoreFixtures);

async function asDesktopApp(page: Page) {
  await page.addInitScript(() => {
    window.__mdrDesktop = true;
  });
}

function heading(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true, level: 1 });
}

/** Opens the three fixtures in order; the third is active. */
async function openThree(page: Page) {
  await page.goto(`/?file=${FIXTURE_1}`);
  await expect(heading(page, HEADING_1)).toBeVisible({ timeout: 10_000 });
  for (const [path, name] of [
    [FIXTURE_2, 'test-doc-2.md'],
    [FIXTURE_3, 'toc-doc.md'],
  ]) {
    await page.evaluate((p) => window.__mdrOpenTarget?.({ file: p }), path);
    await expect(page.getByRole('button', { name: `Close ${name}`, exact: true })).toBeAttached();
  }
  await expect(heading(page, HEADING_3)).toBeVisible();
}

async function openOne(page: Page) {
  await page.goto(`/?file=${FIXTURE_1}`);
  await expect(heading(page, HEADING_1)).toBeVisible({ timeout: 10_000 });
}

async function openPalette(page: Page) {
  await page.keyboard.press(withMod('k'));
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 3_000 });
}

function paletteItem(page: Page, label: string) {
  return page.locator('[data-overlay] button', { hasText: label });
}

const REVEAL = /Show in (Finder|File Explorer|File Manager)|Reveal in File Manager/;

test.describe('Go to tab and tab switching hooks', () => {
  test('__mdrSelectTab picks tabs by position and 9 as the last', async ({ page }) => {
    await openThree(page);
    expect(await page.evaluate(() => window.__mdrSelectTab?.(1))).toBe(true);
    await expect(heading(page, HEADING_1)).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSelectTab?.(2))).toBe(true);
    await expect(heading(page, HEADING_2)).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSelectTab?.(9))).toBe(true);
    await expect(heading(page, HEADING_3)).toBeVisible();

    await page.evaluate(() => window.__mdrSelectTab?.(1));
    await expect(heading(page, HEADING_1)).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSelectTab?.(5))).toBe(false);
    await expect(heading(page, HEADING_1)).toBeVisible();
  });

  test('__mdrSwitchTab moves to the next and previous tab with wrap-around', async ({ page }) => {
    await openThree(page);
    // Third tab is active: next wraps to the first.
    expect(await page.evaluate(() => window.__mdrSwitchTab?.(1))).toBe(true);
    await expect(heading(page, HEADING_1)).toBeVisible();
    // Previous from the first wraps to the last.
    expect(await page.evaluate(() => window.__mdrSwitchTab?.(-1))).toBe(true);
    await expect(heading(page, HEADING_3)).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSwitchTab?.(-1))).toBe(true);
    await expect(heading(page, HEADING_2)).toBeVisible();
  });

  test('__mdrSwitchTab returns false while typing in a text field', async ({ page }) => {
    await openThree(page);
    await page.keyboard.press(withMod('f'));
    await expect(page.locator('input:focus')).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSwitchTab?.(1))).toBe(false);
    await expect(heading(page, HEADING_3)).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSelectTab?.(1))).toBe(false);
    await expect(heading(page, HEADING_3)).toBeVisible();
  });

  test('__mdrSelectTab closes the shortcuts panel before it switches', async ({ page }) => {
    await openThree(page);
    expect(await page.evaluate(() => window.__mdrShowShortcuts?.())).toBe(true);
    const panel = page.getByRole('heading', { name: 'Keyboard Shortcuts' });
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => window.__mdrSelectTab?.(1))).toBe(true);
    await expect(panel).toHaveCount(0);
    await expect(heading(page, HEADING_1)).toBeVisible();
  });
});

test.describe('View menu hooks', () => {
  test('__mdrToggleExplorer toggles the explorer panel', async ({ page }) => {
    await openOne(page);
    const panel = page.locator('[data-sidebar-panel]');
    const before = await panel.count();
    expect(await page.evaluate(() => window.__mdrToggleExplorer?.())).toBe(true);
    await expect(panel).toHaveCount(before > 0 ? 0 : 1);
    expect(await page.evaluate(() => window.__mdrToggleExplorer?.())).toBe(true);
    await expect(panel).toHaveCount(before);
  });

  test('__mdrToggleOutline shows the outline in the panel, as Cmd+Shift+O does', async ({
    page,
  }) => {
    await openOne(page);
    await page.keyboard.press(withMod('Shift+o'));
    const panel = page.locator('[data-sidebar-panel]');
    await expect(panel).toBeVisible();
    const keyOpen = await panel.innerText();
    await page.keyboard.press(withMod('Shift+o'));
    await expect(panel).toHaveCount(0);

    expect(await page.evaluate(() => window.__mdrToggleOutline?.())).toBe(true);
    await expect(panel).toBeVisible();
    expect(await panel.innerText()).toBe(keyOpen);
    expect(await page.evaluate(() => window.__mdrToggleOutline?.())).toBe(true);
    await expect(panel).toHaveCount(0);
  });

  test('__mdrToggleFocusMode enters and leaves focus mode', async ({ page }) => {
    await openOne(page);
    const chip = page.locator('[data-focus-chip]');
    await expect(chip).toHaveCount(0);
    expect(await page.evaluate(() => window.__mdrToggleFocusMode?.())).toBe(true);
    await expect(chip).toHaveCount(1);
    expect(await page.evaluate(() => window.__mdrToggleFocusMode?.())).toBe(true);
    await expect(chip).toHaveCount(0);
  });

  test('the view hooks and settings do nothing under the Mermaid fullscreen view', async ({
    page,
  }) => {
    await page.goto(`/?file=${MERMAID_FIXTURE}`);
    await page.locator('.mermaid-block .mermaid-svg svg').first().waitFor({ timeout: 15_000 });
    const block = page.locator('.mermaid-block').first();
    await block.hover();
    await block.locator('.mermaid-block-expand').click();
    const modal = page.locator('.mermaid-fullscreen-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const panel = page.locator('[data-sidebar-panel]');
    const panelCount = await panel.count();
    expect(await page.evaluate(() => window.__mdrToggleExplorer?.())).toBe(false);
    expect(await page.evaluate(() => window.__mdrOpenSettings?.())).toBe(false);
    await expect(panel).toHaveCount(panelCount);
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(modal).toBeVisible();
  });
});

test.describe('About and Show in Finder', () => {
  const links = ['GitHub', 'Report an issue', 'Release notes'];

  test('__mdrOpenSettings("about") opens the About section in a browser, with no desktop row', async ({
    page,
  }) => {
    await openOne(page);
    expect(await page.evaluate(() => window.__mdrOpenSettings?.('about'))).toBe(true);
    const about = page.locator('[data-settings-about]');
    await expect(about).toBeVisible();
    await expect(about.getByText('Version', { exact: true })).toBeVisible();
    await expect(about.locator('dd').first()).toHaveText(/\d+\.\d+\.\d+/);
    for (const name of links) await expect(about.getByRole('link', { name })).toBeVisible();
    await expect(about.getByText('Desktop app', { exact: true })).toHaveCount(0);
  });

  test('inside the desktop app About also shows the desktop version', async ({ page }) => {
    await asDesktopApp(page);
    await page.addInitScript(() => {
      window.__mdrDesktopVersion = '0.6.0';
    });
    await openOne(page);
    expect(await page.evaluate(() => window.__mdrOpenSettings?.('about'))).toBe(true);
    const about = page.locator('[data-settings-about]');
    await expect(about).toBeVisible();
    await expect(about.getByText('Desktop app', { exact: true })).toBeVisible();
    await expect(about.getByText('0.6.0', { exact: true })).toBeVisible();
    for (const name of links) await expect(about.getByRole('link', { name })).toBeVisible();
  });

  test("the palette's About mdr opens the About section", async ({ page }) => {
    await openOne(page);
    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('about');
    await paletteItem(page, 'About mdr').click();
    await expect(page.locator('[data-settings-about]')).toBeVisible();
  });

  test('the palette lists the reveal entry only with a tab open', async ({ page }) => {
    await page.goto('/');
    await openPalette(page);
    await page.getByPlaceholder('Type a command...').fill('show in');
    await expect(paletteItem(page, 'About mdr')).toHaveCount(0);
    await expect(page.locator('[data-overlay] button', { hasText: REVEAL })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await openOne(page);
    await openPalette(page);
    // "Show in Finder", "Show in File Explorer" or "Show in File Manager".
    await page.getByPlaceholder('Type a command...').fill('show in');
    // Listed only; never executed (it would open a real Finder window).
    await expect(page.locator('[data-overlay] button', { hasText: REVEAL })).toHaveCount(1);
  });
});

test.describe('Opening and navigating', () => {
  test('__mdrOpenTarget({ files }) opens all in order with the first active', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((files) => window.__mdrOpenTarget?.({ files }), [FIXTURE_2, FIXTURE_1]);
    await expect(heading(page, HEADING_2)).toBeVisible({ timeout: 10_000 });
    const closeButtons = page.getByRole('button', { name: /^Close .*\.md$/ });
    await expect(closeButtons).toHaveCount(2);
    await expect(closeButtons.nth(0)).toHaveAccessibleName('Close test-doc-2.md');
    await expect(closeButtons.nth(1)).toHaveAccessibleName('Close test-doc.md');
    await expect(heading(page, HEADING_1)).toHaveCount(0);
  });

  test('__mdrJumpToComment activates comments, as N and P do', async ({ page }) => {
    await openOne(page);
    await addComment(page, 'valid credentials', 'First nav comment');
    await addComment(page, 'brute force attacks', 'Second nav comment');
    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => window.__mdrJumpToComment?.(1))).toBe(true);
    await expect(getCard(page, 'First nav comment')).toHaveClass(/ring-1/);
    expect(await page.evaluate(() => window.__mdrJumpToComment?.(1))).toBe(true);
    await expect(getCard(page, 'Second nav comment')).toHaveClass(/ring-1/);
    expect(await page.evaluate(() => window.__mdrJumpToComment?.(-1))).toBe(true);
    await expect(getCard(page, 'First nav comment')).toHaveClass(/ring-1/);
  });
});
