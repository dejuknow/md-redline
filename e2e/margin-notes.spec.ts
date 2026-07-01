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
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
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

    // Vertical alignment: card top within 24px of the anchor mark's top.
    const markBox = await page.locator('mark.comment-highlight').first().boundingBox();
    const cardBox = await card.boundingBox();
    expect(markBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(Math.abs(cardBox!.y - markBox!.y)).toBeLessThanOrEqual(24);
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
});
