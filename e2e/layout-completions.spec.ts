import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE, TOC_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { addComment } from './helpers/comments';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';
let tocPath = '';

test.use({ viewport: { width: 1700, height: 950 } });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `layout-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  tocPath = resolve(fixtureDir, 'toc-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  writeFileSync(tocPath, TOC_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFile(page: Page, path: string) {
  await page.goto(`/?file=${path}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

test.describe('Density strip', () => {
  test('shows a tick for a comment; clicking it activates the anchor', async ({ page }) => {
    await openFile(page, fixturePath);
    await addComment(page, 'valid credentials', 'Strip target');

    const tick = page.locator('[data-density-strip] [data-tick-id]');
    await expect(tick).toHaveCount(1);
    await tick.click();
    await expect(page.locator('mark.comment-highlight-active')).toBeVisible();
  });

  test('clicking at the scrollbar edge does not trigger a tick jump', async ({ page }) => {
    await openFile(page, fixturePath);
    await addComment(page, 'valid credentials', 'Edge click test');

    // Adding a comment leaves it active; re-open the file so nothing starts
    // active and the no-jump assertion below is meaningful. Comments persist
    // to disk, so the tick is still there.
    await openFile(page, fixturePath);

    const tick = page.locator('[data-density-strip] [data-tick-id]');
    await expect(tick).toHaveCount(1);
    await expect(page.locator('mark.comment-highlight-active')).not.toBeVisible();

    // True panel right edge: the scroll container hosting the page sheet.
    // Not .prose, which is inset from the panel edge by sheet padding (and by
    // the rail when it shows).
    const panelRight = await page
      .locator('[data-doc-page]')
      .evaluate((el) => el.parentElement!.getBoundingClientRect().right);

    // Click inside the scrollbar band (right of the lane at right: 14), at the
    // tick's own vertical position: the strongest miss case. Before the lane
    // inset, the strip hugged right: 0 and this exact point landed on the tick.
    const tickBox = await tick.boundingBox();
    expect(tickBox).not.toBeNull();
    const clickX = panelRight - 6;
    const clickY = tickBox!.y + tickBox!.height / 2;
    await page.mouse.click(clickX, clickY);

    // No tick fired: negation of the same signal the positive case uses.
    await expect(page.locator('mark.comment-highlight-active')).not.toBeVisible();

    // The tick itself is still clickable in its own lane.
    await tick.click();
    await expect(page.locator('mark.comment-highlight-active')).toBeVisible();
  });
});

test.describe('Section breadcrumb', () => {
  test('appears after scrolling past the first heading and names the section', async ({
    page,
  }) => {
    await openFile(page, tocPath);
    await expect(page.locator('[data-section-breadcrumb]')).not.toBeVisible();

    // Scroll deep into the document.
    await page.locator('.prose').evaluate((el) => {
      el.closest('.overflow-y-auto')!.scrollTop = 2000;
    });
    const crumb = page.locator('[data-section-breadcrumb]');
    await expect(crumb).toBeVisible();
    await expect(crumb).toContainText('Project Specification');
  });
});

test.describe('Focus mode', () => {
  test('hides panes and margin notes; second toggle restores', async ({ page }) => {
    await openFile(page, fixturePath);
    await addComment(page, 'valid credentials', 'Focus check');

    // Baseline: explorer visible (default), sidebar visible (default).
    // Exact match: "Explorer" is also a substring of the toolbar's
    // "Toggle file explorer sidebar" icon button, which never hides.
    const explorerTab = page.getByRole('button', { name: 'Explorer', exact: true });
    await expect(explorerTab).toBeVisible();

    await page.keyboard.press(withMod('.'));
    await expect(explorerTab).not.toBeVisible();
    await expect(page.locator('[data-margin-notes]')).not.toBeVisible();
    await expect(page.locator('[data-focus-chip]')).toBeVisible();
    // Strip still available in focus mode.
    await expect(page.locator('[data-density-strip]')).toBeVisible();

    await page.keyboard.press(withMod('.'));
    await expect(explorerTab).toBeVisible();
    await expect(page.locator('[data-focus-chip]')).not.toBeVisible();
  });
});

test.describe('Merged chrome', () => {
  test('tabs render in the title row and stay functional', async ({ page }) => {
    await openFile(page, fixturePath);
    // The tab and the settings button share one row: same bounding-box band.
    // Scoped to the title row and de-duped with hasText: the bare "test-doc.md"
    // text also matches the tab's nested close control and the explorer's
    // file-list entry outside this row.
    const tab = page.locator('.h-11 button', { hasText: 'test-doc.md' }).first();
    const settings = page.locator('button[title*="Settings"]');
    const tabBox = await tab.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(tabBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(Math.abs(tabBox!.y - settingsBox!.y)).toBeLessThanOrEqual(12);

    // Open a second file via the plus button and switch back.
    await page.getByRole('button', { name: 'Open file' }).click();
    await page.keyboard.type(tocPath);
    await page.keyboard.press('Enter');
    await page.locator('.prose').waitFor();
    await tab.click();
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
  });
});
