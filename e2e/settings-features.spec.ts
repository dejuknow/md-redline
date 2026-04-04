import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
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

async function selectText(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const walker = document.createTreeWalker(
      document.querySelector('.prose') || document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.textContent?.indexOf(targetText) ?? -1;
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + targetText.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        const rect = range.getBoundingClientRect();
        node.parentElement?.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
        return;
      }
    }
    throw new Error(`Text "${targetText}" not found in rendered markdown`);
  }, text);
}

async function addComment(page: Page, anchorText: string, commentText: string) {
  await selectText(page, anchorText);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
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
  // Open settings via the toolbar gear button
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  // Find the toggle switch associated with the setting label
  const settingLabel = panel.locator('label', { hasText: settingName });
  await settingLabel.locator('button[role="switch"]').click();
  // Close settings
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

// ---------------------------------------------------------------------------
// Resolve workflow
// ---------------------------------------------------------------------------

test.describe('Resolve workflow toggle', () => {
  test('resolve/reopen actions appear when resolve workflow is enabled', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Resolve test comment');

    // By default resolve is off — no Resolve button on card
    const card = getCard(page, 'Resolve test comment');
    await card.hover();
    await expect(card.getByRole('button', { name: 'Resolve', exact: true })).not.toBeVisible();

    // Enable resolve workflow
    await toggleSetting(page, 'Enable resolve workflow');

    // Now the Resolve button should appear
    await card.hover();
    await expect(card.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  });

  test('resolving a comment dims it and shows resolved badge', async ({ page }) => {
    await openFixture(page);

    // Enable resolve workflow first
    await toggleSetting(page, 'Enable resolve workflow');

    await addComment(page, 'valid credentials', 'Will be resolved');

    await clickCardAction(page, 'Will be resolved', 'Resolve');

    // The card should show a "Resolved" badge
    const card = getCard(page, 'Will be resolved');
    await expect(card.getByText('Resolved', { exact: true })).toBeVisible();
  });

  test('resolved comments are skipped during keyboard navigation', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Enable resolve workflow');

    await addComment(page, 'valid credentials', 'Open comment');
    await addComment(page, 'brute force attacks', 'To be resolved');
    await addComment(page, 'hashed with bcrypt', 'Another open');

    // Resolve the middle comment
    await clickCardAction(page, 'To be resolved', 'Resolve');

    // Clear any active state
    await page.keyboard.press('Escape');

    // Press N to cycle — should skip the resolved comment
    await page.keyboard.press('n');
    await expect(getCard(page, 'Open comment')).toHaveClass(/ring-1/);

    await page.keyboard.press('n');
    // Should skip "To be resolved" and go to "Another open"
    await expect(getCard(page, 'Another open')).toHaveClass(/ring-1/);
  });

  test('resolved comments hide reply edit and delete actions', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Enable resolve workflow');

    await addComment(page, 'valid credentials', 'Resolved reply test');

    const card = getCard(page, 'Resolved reply test');

    // Add a reply
    await card.getByRole('button', { name: 'Reply' }).click();
    const replyArea = card.getByPlaceholder('Write a reply...');
    await replyArea.fill('A reply');
    await card.locator('textarea + div').getByRole('button', { name: 'Reply' }).click();

    const reply = card.locator('[data-reply-id]').first();
    await expect(reply).toContainText('A reply');

    // Before resolving, reply actions should be available
    await reply.hover();
    await expect(reply.getByRole('button', { name: 'Edit' })).toBeVisible();

    // Resolve the comment
    await clickCardAction(page, 'Resolved reply test', 'Resolve');
    await expect(card.getByText('Resolved', { exact: true })).toBeVisible();

    // After resolving, reply edit/delete should be hidden
    await reply.hover();
    await expect(reply.getByRole('button', { name: 'Edit' })).not.toBeVisible();

    // Primary comment should still have Reopen and Delete
    await card.hover();
    await expect(card.getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  test('hiding resolve actions when toggle is turned off', async ({ page }) => {
    await openFixture(page);

    // Enable then disable
    await toggleSetting(page, 'Enable resolve workflow');
    await addComment(page, 'valid credentials', 'Toggle off test');

    const card = getCard(page, 'Toggle off test');
    await card.hover();
    await expect(card.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();

    await toggleSetting(page, 'Enable resolve workflow');

    await card.hover();
    await expect(card.getByRole('button', { name: 'Resolve', exact: true })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Quick comment mode
// ---------------------------------------------------------------------------

test.describe('Quick comment mode', () => {
  test('form opens expanded immediately when quick comment is enabled', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Quick comment');

    await selectText(page, 'valid credentials');

    // The textarea should be immediately visible (no "Comment" button step)
    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible({ timeout: 5000 });
  });

  test('click outside with empty text dismisses the quick comment form', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Quick comment');

    await selectText(page, 'valid credentials');
    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible({ timeout: 5000 });

    // Click on an area outside the form and outside the prose (e.g., the toolbar area)
    await page.locator('h2', { hasText: 'Comments' }).click();

    // Form should be dismissed
    await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible();
  });

  test('click outside with text does NOT dismiss the quick comment form', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Quick comment');

    await selectText(page, 'valid credentials');
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible({ timeout: 5000 });

    await textarea.fill('Important feedback');

    // Click outside
    await page.locator('h2', { hasText: 'Comments' }).click();

    // Form should still be visible since it has text
    await expect(textarea).toBeVisible();
  });

  test('submitting a quick comment works normally', async ({ page }) => {
    await openFixture(page);
    await toggleSetting(page, 'Quick comment');

    await selectText(page, 'valid credentials');
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.fill('Quick comment test');

    // Submit via keyboard shortcut
    await page.keyboard.press(withMod('Enter'));

    await expect(page.getByText('Quick comment test', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Middle-click tab close
// ---------------------------------------------------------------------------

test.describe('Middle-click tab close', () => {
  test('middle-clicking a tab closes it', async ({ page }) => {
    await openFixture(page);

    // Open a second file via the + button in the tab bar
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(FIXTURE_2);
    await page.getByPlaceholder('File path or name...').press('Enter');
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });

    // Both tabs visible
    const tabBar = page.locator('.h-9');
    const tab1 = tabBar.locator('button', { hasText: 'test-doc.md' }).first();
    const tab2 = tabBar.locator('button', { hasText: 'test-doc-2.md' });
    await expect(tab1).toBeVisible();
    await expect(tab2).toBeVisible();

    // Middle-click the first tab to close it
    await tab1.click({ button: 'middle' });

    await expect(tab1).not.toBeVisible();
    // Second tab should still be open
    await expect(tab2).toBeVisible();
  });
});
