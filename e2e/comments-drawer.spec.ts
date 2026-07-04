import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { addComment, commentsFab, commentsDrawer, openCommentsDrawer } from './helpers/comments';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

// The rail needs roughly 888px of content width to fit (see COL_MIN /
// RAIL_FOOTPRINT in src/lib/page-geometry.ts). A narrow window guarantees it
// never shows, so the FAB/drawer is the only comment surface; a wide one
// guarantees it does.
const NARROW_VIEWPORT = { width: 800, height: 900 };
const WIDE_VIEWPORT = { width: 1700, height: 950 };

test.use({ viewport: NARROW_VIEWPORT });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `comments-drawer-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // The rail/column width change and the drawer's overlay animation are
  // both motion-safe; disable motion so assertions read settled state
  // rather than a mid-transition one.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

async function switchToRaw(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
}

const rail = (page: Page) => page.locator('[data-comments-rail]');

test.describe('Comments FAB and drawer', () => {
  test('narrow rendered view: FAB shows the open count, opens the drawer, a card activates its anchor, and Escape closes it', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Narrow drawer comment');

    // The rail cannot fit at this width.
    await expect(rail(page)).toHaveCount(0);

    const fab = commentsFab(page);
    await expect(fab).toBeVisible();
    await expect(fab).toHaveAttribute('aria-label', 'Open comments (1 open)');

    await fab.click();
    const drawer = commentsDrawer(page);
    await expect(drawer).toBeVisible();
    const card = drawer.locator('.group.rounded-lg', { hasText: 'Narrow drawer comment' });
    await expect(card).toBeVisible();

    await card.click();
    await expect(page.locator('mark.comment-highlight-active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });

  test('raw view: FAB is visible and the drawer lists comments', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Raw view comment');

    await switchToRaw(page);
    // No rail ever shows in raw view, regardless of width.
    await expect(rail(page)).toHaveCount(0);
    await expect(commentsFab(page)).toBeVisible();

    await openCommentsDrawer(page);
    await expect(
      commentsDrawer(page).locator('.group.rounded-lg', { hasText: 'Raw view comment' }),
    ).toBeVisible();
  });

  test('wide rendered view: the rail shows and the FAB is absent', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Wide view comment');

    await page.setViewportSize(WIDE_VIEWPORT);
    await expect(rail(page)).toBeVisible();
    await expect(commentsFab(page)).toHaveCount(0);
  });

  test('zero comments: the FAB stays hidden even at a narrow width', async ({ page }) => {
    await openFixture(page);
    await expect(commentsFab(page)).toHaveCount(0);
  });

  test(`${withMod('\\')} at a narrow width toggles the drawer`, async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Shortcut drawer comment');

    const drawer = commentsDrawer(page);
    await expect(drawer).not.toBeVisible();

    await page.keyboard.press(withMod('\\'));
    await expect(drawer).toBeVisible();

    await page.keyboard.press(withMod('\\'));
    await expect(drawer).not.toBeVisible();
  });
});
