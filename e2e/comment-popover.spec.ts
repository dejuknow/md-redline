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

// The rail needs roughly 888px of content width to fit (see COL_MIN /
// RAIL_FOOTPRINT in src/lib/page-geometry.ts). A narrow window guarantees it
// never shows, so the popover is the only single-comment surface; a wide one
// guarantees the rail shows instead.
const NARROW_VIEWPORT = { width: 800, height: 900 };
const WIDE_VIEWPORT = { width: 1700, height: 950 };

test.use({ viewport: NARROW_VIEWPORT });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `comment-popover-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // The popover's enter animation and the rail/column width change are both
  // motion-safe; disable motion so assertions read settled state rather
  // than a mid-transition one.
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

function popover(page: Page) {
  return page.locator('[data-comment-popover]');
}

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

async function clickCardAction(page: Page, commentText: string, actionName: string) {
  const card = getCard(page, commentText);
  await card.hover();
  await card.getByRole('button', { name: actionName, exact: true }).click({ force: true });
}

/** Enable a boolean setting via the Settings panel toggle */
async function toggleSetting(page: Page, settingName: string) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  const settingLabel = panel.locator('label', { hasText: settingName });
  await settingLabel.locator('button[role="switch"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

async function switchToListDensity(page: Page) {
  await page.locator('[data-rail-header] button', { hasText: 'List' }).click();
}

test.describe('Highlight popover (rail-hidden contexts)', () => {
  test('clicking a highlight opens the popover with the comment text and author byline; Esc and an outside click both close it', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Popover comment one');

    // Creation while the rail is hidden auto-opens the popover; close it so
    // this test can exercise the click-to-open path on its own.
    const pop = popover(page);
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();

    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Popover comment one');
    await expect(pop).toContainText('User'); // default author byline

    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();

    // Reopen, then close via a click on the prose outside the popover.
    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toBeVisible();
    await page.getByRole('heading', { name: 'Section Three' }).click();
    await expect(pop).not.toBeVisible();
  });

  test('replying inside the popover lands the reply in the file', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Popover reply target');

    const pop = popover(page);
    await expect(pop).toBeVisible();

    await pop.getByRole('button', { name: 'Reply' }).click();
    await pop.locator('textarea').fill('Reply from the popover');
    await page.keyboard.press(withMod('Enter'));

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('Reply from the popover');

    // Close and reopen on the same highlight: the reply persists on the card.
    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();
    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toContainText('Reply from the popover');
  });

  test('creating a comment at a narrow width opens the popover on the new comment automatically', async ({
    page,
  }) => {
    await openFixture(page);

    // No rail at this width: the comment surface is the FAB/drawer, and the
    // popover is what opens automatically on the just-created comment.
    await expect(page.locator('[data-comments-rail]')).toHaveCount(0);

    await addComment(page, 'brute force attacks', 'Auto-opened popover comment');

    const pop = popover(page);
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Auto-opened popover comment');
  });
});

test.describe('Filter auto-widen', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('clicking an open comment highlight while the Resolved filter hides it switches the filter and activates the card', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Auto-widen open comment');
    await addComment(page, 'brute force attacks', 'Auto-widen resolved comment');

    await toggleSetting(page, 'Enable resolve workflow');
    await switchToListDensity(page);

    await clickCardAction(page, 'Auto-widen resolved comment', 'Resolve');

    // Filter to Resolved: the open comment's card leaves the list.
    await page
      .locator('[data-comments-rail] .flex.gap-1 button', { hasText: 'Resolved' })
      .click();
    await expect(getCard(page, 'Auto-widen resolved comment')).toBeVisible();
    await expect(getCard(page, 'Auto-widen open comment')).not.toBeVisible();

    // Clicking the open comment's highlight means "show me this comment":
    // the filter widens to include it and its card becomes active.
    await page.locator('mark.comment-highlight', { hasText: 'valid credentials' }).click();

    const openCard = getCard(page, 'Auto-widen open comment');
    await expect(openCard).toBeVisible();
    await expect(openCard).toHaveClass(/border-primary-border/);
  });
});
