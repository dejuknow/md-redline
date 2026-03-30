import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_2_BASELINE, TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = TEST_DOC_BASELINE;
const FIXTURE_2_ORIGINAL = TEST_DOC_2_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
});

async function openFixture(page: Page, fixture: string = FIXTURE_1) {
  await page.goto(`/?file=${fixture}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
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
  // Wait for the comment form to close (confirms save completed)
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Hand-off button visibility
// ---------------------------------------------------------------------------

test.describe('Hand-off button', () => {
  test('is not visible when there are no comments', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByTestId('handoff-group')).not.toBeVisible();
  });

  test('appears when a comment is added', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });
  });

  test('disappears when all comments are deleted', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    // Delete all comments via command palette
    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('Delete all');
    await page.getByText('Delete all comments').click();

    await expect(page.getByTestId('handoff-group')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Single-file hand-off
// ---------------------------------------------------------------------------

test.describe('Single-file hand-off', () => {
  test('copies instructions to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    // Check toast
    await expect(page.getByText('Copied agent instructions for 1 file')).toBeVisible();

    // Verify clipboard content
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('inline comment markers');
    expect(clipboard).toContain('<!-- @comment{JSON} -->');
    expect(clipboard).toContain('test-doc.md');
  });

  test('prompt instructs agent to delete markers by default', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('remove the entire');
  });

  test('chevron is not interactable with single file', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    // Chevron should exist but be invisible (opacity-0, pointer-events-none)
    const chevron = page.getByTestId('handoff-chevron');
    await expect(chevron).toHaveCSS('opacity', '0');
    await expect(chevron).toHaveCSS('pointer-events', 'none');
  });
});

// ---------------------------------------------------------------------------
// Resolve-mode hand-off prompt
// ---------------------------------------------------------------------------

async function toggleSetting(page: Page, settingName: string) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  const settingLabel = panel.locator('label', { hasText: settingName });
  await settingLabel.locator('button[role="switch"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

test.describe('Resolve-mode hand-off', () => {
  test('prompt includes reply instruction when resolve workflow is enabled', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'How important is this?');
    await toggleSetting(page, 'Enable resolve workflow');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('add a reply');
    expect(clipboard).toContain('"author":"Agent"');
    expect(clipboard).toContain('resolve it');
    expect(clipboard).not.toContain('remove the entire');
  });

  test('default mode prompt does not include reply instruction', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('remove the entire');
    expect(clipboard).not.toContain('add a reply');
  });
});

// ---------------------------------------------------------------------------
// Multi-file hand-off
// ---------------------------------------------------------------------------

test.describe('Multi-file hand-off', () => {
  async function setupTwoFilesWithComments(page: Page) {
    // Open first file and add comment
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'authentication system', 'Fix auth flow');

    // Open second file via the + tab button (preserves first tab)
    await page.locator('button[title="Open file"]').click();
    const input = page.getByPlaceholder('File path or name...');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill(FIXTURE_2);
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({ timeout: 10_000 });
    await addComment(page, 'second test document', 'Fix introduction');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });
  }

  test('chevron appears when multiple files have comments', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    const chevron = page.getByTestId('handoff-chevron');
    // Should be visible (not opacity-0)
    await expect(chevron).not.toHaveCSS('opacity', '0');
  });

  test('dropdown shows all files with comments', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText('test-doc.md')).toBeVisible();
    await expect(dropdown.getByText('test-doc-2.md')).toBeVisible();
  });

  test('all files are pre-selected in dropdown', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // The CTA should say 2 files
    await expect(dropdown.getByText('Copy handoff for 2 files')).toBeVisible();
  });

  test('can deselect a file and button updates', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // Deselect first file
    await dropdown.locator('button', { hasText: 'test-doc.md' }).first().click();

    // Button text should reflect 1 file
    await expect(dropdown.getByText('Copy handoff for 1 file')).toBeVisible();
  });

  test('button is disabled when no files selected', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // Deselect both files
    await dropdown.locator('button', { hasText: 'test-doc.md' }).first().click();
    await dropdown.locator('button', { hasText: 'test-doc-2.md' }).click();

    const copyBtn = dropdown.locator('button', { hasText: 'Select files to hand off' });
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toBeDisabled();
  });

  test('multi-file prompt includes file list', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    await dropdown.getByText('Copy handoff for 2 files').click();

    await expect(page.getByText('Copied agent instructions for 2 files')).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('Files to review');
    expect(clipboard).toContain('test-doc.md');
    expect(clipboard).toContain('test-doc-2.md');
  });

  test('dropdown closes on click outside', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();
    const dropdown = page.locator('.absolute.right-0.top-full');
    await expect(dropdown).toBeVisible();

    // Click outside
    await page.locator('.prose').click({ position: { x: 10, y: 10 } });
    await expect(dropdown).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Command palette integration
// ---------------------------------------------------------------------------

test.describe('Command palette hand-off', () => {
  test('hand-off command appears when comments exist', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');

    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('hand off');
    await expect(page.getByText('Hand off to agent')).toBeVisible();
  });

  test('hand-off command does not appear without comments', async ({ page }) => {
    await openFixture(page);

    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('hand off');
    await expect(page.getByText('Hand off to agent')).not.toBeVisible();
  });
});
