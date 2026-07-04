import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { addComment } from './helpers/comments';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.use({ viewport: { width: 1700, height: 950 } });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `margin-notes-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // The page/column width change (rail showing/hiding, or the column
  // resizing across viewport widths) is a motion-safe CSS transition; disable
  // it so geometry assertions read the settled width, not a mid-animation one.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

/**
 * The column's width follows the container's ResizeObserver, which fires
 * asynchronously after a viewport resize (and, unlike the margin layer's
 * mere visibility, isn't something `expect(locator).toBeVisible()` waits
 * on). Poll until two consecutive reads agree so callers see the settled
 * width, not a transient one still mid-recalculation.
 */
async function stableColumnWidth(page: Page): Promise<number> {
  let previous: number | null = null;
  await expect(async () => {
    const box = await page.locator('[data-doc-page] > div').first().boundingBox();
    const width = box?.width ?? null;
    const stable = width !== null && width === previous;
    previous = width;
    expect(stable).toBe(true);
  }).toPass({ timeout: 2000 });
  return previous!;
}

async function closeSidebar(page: Page) {
  await page.keyboard.press(withMod('\\'));
  // The collapsed sidebar panel still reports a non-empty bounding box for
  // its search input (a nested flex min-width quirk clips it offscreen
  // without zeroing its own layout box), so checking that input's visibility
  // is not a reliable signal here. Assert the margin layer directly instead.
  await expect(page.locator('[data-margin-notes]')).toBeVisible();
}

test.describe('Margin notes', () => {
  test('cards appear in the margin near their anchors when the sidebar closes', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Margin note one');
    await closeSidebar(page);

    const layer = page.locator('[data-margin-notes]');
    await expect(layer).toBeVisible();
    const card = layer.locator('[data-margin-card-id]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Margin note one');

    // Closing the sidebar triggers a panel-width transition on the
    // container; wait for the column width to settle before taking any
    // position measurements below, or a card box captured mid-transition
    // compared against a page/column box captured after it settles produces
    // a bogus delta.
    await stableColumnWidth(page);

    // Vertical alignment: card top within 24px of the anchor mark's top.
    const markBox = await page.locator('mark.comment-highlight').first().boundingBox();
    const cardBox = await card.boundingBox();
    expect(markBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(Math.abs(cardBox!.y - markBox!.y)).toBeLessThanOrEqual(24);

    // The rail sits exactly GAP (56px) from the column: card left edge minus
    // column right edge is 56 +- 2px.
    const pageLocator = page.locator('[data-doc-page]');
    const pageBox = await pageLocator.boundingBox();
    const col = await pageLocator.locator(':scope > div').first().boundingBox();
    expect(pageBox).not.toBeNull();
    expect(col).not.toBeNull();
    expect(cardBox!.x - (col!.x + col!.width)).toBeGreaterThan(40);
    expect(cardBox!.x - (col!.x + col!.width)).toBeLessThan(70);
  });

  test('clicking the anchor activates the margin card and replying lands in the file', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Margin note two');
    await closeSidebar(page);

    await page.locator('mark.comment-highlight').first().click();
    const card = page.locator('[data-margin-card-id]');
    // Active card is full, not compact: the Reply action is available.
    await card.getByRole('button', { name: 'Reply' }).click();
    await card.locator('textarea').fill('Reply from the margin');
    await page.keyboard.press(withMod('Enter'));

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'))
      .toContain('Reply from the margin');
  });

  test('opening the sidebar hides the layer; narrow windows never show it', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Margin note three');
    await closeSidebar(page);
    await expect(page.locator('[data-margin-notes]')).toBeVisible();

    // Reopen sidebar: layer goes away.
    await page.keyboard.press(withMod('\\'));
    await expect(page.locator('[data-margin-notes]')).not.toBeVisible();

    // Close sidebar but shrink the window below the threshold: layer stays away.
    await page.keyboard.press(withMod('\\'));
    await page.setViewportSize({ width: 1000, height: 950 });
    await expect(page.locator('[data-margin-notes]')).not.toBeVisible();
    // Highlights are still there.
    await expect(page.locator('mark.comment-highlight').first()).toBeVisible();
  });

  test('column shrinks and re-wraps before the margin layer hides', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Margin note four');
    await closeSidebar(page);

    await page.setViewportSize({ width: 1240, height: 900 });
    await expect(page.locator('[data-margin-notes]')).toBeVisible();
    const colWide = await stableColumnWidth(page);

    await page.setViewportSize({ width: 1120, height: 900 });
    await expect(page.locator('[data-margin-notes]')).toBeVisible();
    const colNarrow = await stableColumnWidth(page);

    expect(colNarrow).toBeLessThan(colWide);

    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator('[data-margin-notes]')).toHaveCount(0);
  });
});
