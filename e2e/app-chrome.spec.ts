import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_ROOT = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let FIXTURE = '';
let OVERFLOW_FIXTURES: string[] = [];

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_ROOT, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_ROOT,
    `app-chrome-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  FIXTURE = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  OVERFLOW_FIXTURES = Array.from({ length: 8 }, (_, index) => {
    const path = resolve(fixtureDir, `overflow-tab-${index + 1}.md`);
    writeFileSync(
      path,
      TEST_DOC_BASELINE.replace('# Test Document', `# Overflow Tab ${index + 1}`),
    );
    return path;
  });
  await resetTestAppState(page);
});

test.afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

const strip = (page: Page) => page.locator('[data-doc-strip]');

test.describe('Document panel strip', () => {
  test('raw view with changes keeps the diff bar and a way back to rendered', async ({
    page,
    context,
  }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    // A handoff takes the snapshot the diff compares against.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await addComment(page, 'Section One', 'placeholder');
    await page.getByTestId('handoff-button').click();
    await expect(page.getByText(/tracking changes/i)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    // An outside edit after the snapshot gives the diff something to show.
    const current = readFileSync(FIXTURE, 'utf-8');
    writeFileSync(FIXTURE, current.replace('## Section Two', '## Updated Section Two'));
    await expect(page.getByRole('heading', { name: 'Updated Section Two' })).toBeVisible({
      timeout: 15_000,
    });

    await strip(page).locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view')).toBeVisible();

    // Entering raw with changes turns the overlay on by itself: no toggle click.
    await expect(strip(page).locator('button[title="Hide diff"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-diff-bar]')).toBeVisible();
    await expect(page.getByTestId('diff-reference-label')).toBeVisible();

    const back = strip(page).locator('button[title="Switch to rendered view"]');
    await expect(back).toBeEnabled();
    await back.click();
    await expect(page.locator('.raw-view')).not.toBeVisible();
    await expect(page.locator('.prose')).toBeVisible();
  });

  test('selecting an overflow tab from the tab list works in a 720px window', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.evaluate((tabs) => {
      localStorage.setItem(
        'md-redline-session',
        JSON.stringify({ openTabs: tabs, activeFilePath: tabs[tabs.length - 1] }),
      );
    }, OVERFLOW_FIXTURES);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overflow Tab 8' })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('tab-list-button').click();
    const menu = page.getByTestId('tab-list-menu');
    await expect(menu).toBeVisible();

    // Not clipped: the whole 288px menu sits inside the window, and its first
    // entry is what is actually on top at its own center.
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(288);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(720);
    const first = menu.locator('button', { hasText: 'overflow-tab-1.md' });
    const onTop = await first.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit != null && el.contains(hit);
    });
    expect(onTop).toBe(true);

    await first.click();
    await expect(page.getByRole('heading', { name: 'Overflow Tab 1' })).toBeVisible();
    await expect(menu).not.toBeVisible();
  });
});
