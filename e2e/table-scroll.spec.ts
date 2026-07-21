import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

// A table wide enough to overflow the sheet, plus a short prose line so the
// document isn't table-only (search opens against real content).
const COLS = 16;
const WIDE_TABLE_DOC = [
  '# Wide Table Scroll',
  '',
  'This document has a paragraph of prose above a very wide table.',
  '',
  '| ' +
    Array.from({ length: COLS }, (_, i) => `Column heading number ${i + 1}`).join(' | ') +
    ' |',
  '| ' + Array.from({ length: COLS }, () => '---').join(' | ') + ' |',
  '| ' + Array.from({ length: COLS }, (_, i) => `data cell value ${i + 1}`).join(' | ') + ' |',
  '',
].join('\n');

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `table-scroll-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'wide-table-doc.md');
  writeFileSync(fixturePath, WIDE_TABLE_DOC);
  await resetTestAppState(page);
});

test.afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Wide Table Scroll' })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('wide-table horizontal scroll', () => {
  test('an overflowing table viewport is keyboard-focusable and labeled', async ({ page }) => {
    await openFixture(page);
    const viewport = page.locator('.table-scroll__viewport').first();
    // tabindex/aria-label are applied at runtime ONLY when the table overflows.
    await expect(viewport).toHaveAttribute('tabindex', '0');
    await expect(viewport).toHaveAttribute('aria-label', 'Scrollable table');
    // At the left edge, only the end (right) fade cue shows.
    await expect(page.locator('.table-scroll').first()).toHaveAttribute('data-overflow-end', '');
  });

  test('preserves horizontal scroll across an unrelated re-render', async ({ page }) => {
    await openFixture(page);
    const viewport = page.locator('.table-scroll__viewport').first();
    // Confirms the table actually overflows before we rely on scrolling it.
    await expect(viewport).toHaveAttribute('tabindex', '0');

    // Scroll to a fixed mid offset — comfortably within range so a re-render's
    // layout re-clamp of maxScroll can't move it. This isolates the exact
    // regression (reset to the left edge) from harmless max re-clamping at the
    // far right.
    const target = await viewport.evaluate((el) => {
      el.scrollLeft = 100;
      return el.scrollLeft;
    });
    expect(target).toBe(100);

    // Trigger a re-render that does NOT change table content or reflow the
    // prose: open search and type a query with no matches. searchQuery is a
    // dep of the viewer effect, so this rebuilds the rendered subtree from
    // innerHTML — the exact path that used to snap the table back to the left.
    // A no-match query avoids adding highlight <mark>s that would nudge prose
    // metrics and re-clamp the table's max scroll.
    await page.keyboard.press(withMod('f'));
    const searchBar = page.locator('[data-testid="search-bar"]');
    await expect(searchBar).toBeVisible();
    await searchBar.getByPlaceholder('Find...').fill('nomatchxyzzy');
    await expect(searchBar.locator('[data-testid="search-match-count"]')).toContainText(
      'No results',
    );

    // The (rebuilt) viewport must still be scrolled to where we left it, not
    // snapped back to the left edge.
    await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
    const after = await viewport.evaluate((el) => el.scrollLeft);
    expect(Math.abs(after - target)).toBeLessThanOrEqual(1);
  });
});
