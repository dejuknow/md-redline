import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Comment navigation with N/J and P/K', () => {
  test('N navigates to next comment, P navigates to previous', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'First nav comment');
    await addComment(page, 'brute force attacks', 'Second nav comment');
    await addComment(page, 'hashed with bcrypt', 'Third nav comment');

    // Clear active state
    await page.keyboard.press('Escape');

    // Press N to jump to first comment
    await page.keyboard.press('n');
    await expect(getCard(page, 'First nav comment')).toHaveClass(/ring-1/);

    // Press N to jump to second
    await page.keyboard.press('n');
    await expect(getCard(page, 'Second nav comment')).toHaveClass(/ring-1/);

    // Press N to jump to third
    await page.keyboard.press('n');
    await expect(getCard(page, 'Third nav comment')).toHaveClass(/ring-1/);

    // Press P to go back to second
    await page.keyboard.press('p');
    await expect(getCard(page, 'Second nav comment')).toHaveClass(/ring-1/);

    // Press P to go back to first
    await page.keyboard.press('p');
    await expect(getCard(page, 'First nav comment')).toHaveClass(/ring-1/);
  });

  test('J/K vim-style navigation works the same as N/P', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'Vim nav first');
    await addComment(page, 'brute force attacks', 'Vim nav second');

    // Clear active state
    await page.keyboard.press('Escape');

    // J = next
    await page.keyboard.press('j');
    await expect(getCard(page, 'Vim nav first')).toHaveClass(/ring-1/);

    await page.keyboard.press('j');
    await expect(getCard(page, 'Vim nav second')).toHaveClass(/ring-1/);

    // K = previous
    await page.keyboard.press('k');
    await expect(getCard(page, 'Vim nav first')).toHaveClass(/ring-1/);
  });

  test('navigation wraps: from last comment, N goes to first', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'Wrap first');
    await addComment(page, 'brute force attacks', 'Wrap second');
    await addComment(page, 'hashed with bcrypt', 'Wrap third');

    // Clear active state
    await page.keyboard.press('Escape');

    // Navigate to last comment
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await expect(getCard(page, 'Wrap third')).toHaveClass(/ring-1/);

    // N from last should wrap to first
    await page.keyboard.press('n');
    await expect(getCard(page, 'Wrap first')).toHaveClass(/ring-1/);
  });

  test('navigation wraps: from first comment, P goes to last', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'Wrap-back first');
    await addComment(page, 'brute force attacks', 'Wrap-back second');
    await addComment(page, 'hashed with bcrypt', 'Wrap-back third');

    // Clear active state
    await page.keyboard.press('Escape');

    // Navigate to first comment
    await page.keyboard.press('n');
    await expect(getCard(page, 'Wrap-back first')).toHaveClass(/ring-1/);

    // P from first should wrap to last
    await page.keyboard.press('p');
    await expect(getCard(page, 'Wrap-back third')).toHaveClass(/ring-1/);
  });

  test('resolved comments are skipped during navigation', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Enable resolve workflow');

    await addComment(page, 'valid credentials', 'Nav open A');
    await addComment(page, 'brute force attacks', 'Nav resolved B');
    await addComment(page, 'hashed with bcrypt', 'Nav open C');

    // Resolve the middle comment
    await clickCardAction(page, 'Nav resolved B', 'Resolve');

    // Clear active state
    await page.keyboard.press('Escape');

    // Press N — should go to first open comment
    await page.keyboard.press('n');
    await expect(getCard(page, 'Nav open A')).toHaveClass(/ring-1/);

    // Press N — should skip resolved and go to third
    await page.keyboard.press('n');
    await expect(getCard(page, 'Nav open C')).toHaveClass(/ring-1/);

    // Press N — should wrap to first (skipping resolved)
    await page.keyboard.press('n');
    await expect(getCard(page, 'Nav open A')).toHaveClass(/ring-1/);
  });
});
