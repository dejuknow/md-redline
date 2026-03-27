import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MOD_LABEL } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = readFileSync(FIXTURE_1, 'utf-8');
const FIXTURE_2_ORIGINAL = readFileSync(FIXTURE_2, 'utf-8');

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
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Recent files tests
// ---------------------------------------------------------------------------

/** The file opener overlay */
const fileOpener = (page: Page) => page.locator('.fixed.inset-0').last();

test.describe('Recent files', () => {
  test('opening a file adds it to recent files list', async ({ page }) => {
    await openFixture(page, FIXTURE_1);

    // Open the file picker to see recent files
    await page.locator('button[title="Open file"]').click();

    // The file should appear in the picker's recent list (scope to the opener overlay)
    const opener = fileOpener(page);
    // The file name appears in the list items — use first() to avoid strict mode
    await expect(opener.getByText('test-doc.md').first()).toBeVisible({ timeout: 5000 });
  });

  test('recent files persist across page reload', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await page.waitForTimeout(500);

    // Navigate to a blank page, then back to the app
    await page.goto('/');
    await page.waitForTimeout(500);

    // Open the file picker
    await page.locator('button[title="Open file"]').first().click();

    const opener = fileOpener(page);
    await expect(opener.getByText('test-doc.md').first()).toBeVisible({ timeout: 5000 });
  });

  test('multiple files appear in recent list', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await page.waitForTimeout(300);

    await page.goto(`/?file=${FIXTURE_2}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);

    await page.locator('button[title="Open file"]').click();

    const opener = fileOpener(page);
    await expect(opener.getByText('test-doc.md').first()).toBeVisible({ timeout: 5000 });
    await expect(opener.getByText('test-doc-2.md').first()).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Author management tests
// ---------------------------------------------------------------------------

/** Get the author name input in the settings panel */
function authorInput(page: Page) {
  // The input is right after the "Author Name" heading in the settings panel
  return page.locator('input.w-60').first();
}

test.describe('Author management', () => {
  test('changing author name in settings persists on new comments', async ({ page }) => {
    await openFixture(page);

    // Open settings
    await page.locator(`button[title="Settings (${MOD_LABEL}+,)"]`).click();
    await expect(page.getByText('Author Name')).toBeVisible();

    // Change the author name
    const input = authorInput(page);
    await input.fill('TestReviewer');
    // Trigger onBlur to commit the change
    await input.blur();
    await page.waitForTimeout(200);

    // Close settings
    await page.keyboard.press('Escape');

    // Add a comment — it should have the new author name
    await addComment(page, 'valid credentials', 'Author test comment');

    // The comment card should show the author name (use first() — it also appears in toolbar)
    await expect(page.getByText('TestReviewer').first()).toBeVisible();
  });

  test('author name persists across page reload', async ({ page }) => {
    await openFixture(page);

    // Open settings and change author
    await page.locator(`button[title="Settings (${MOD_LABEL}+,)"]`).click();
    const input = authorInput(page);
    await input.fill('PersistentUser');
    await input.blur();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');

    await page.waitForTimeout(500);

    // Reload and verify
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await page.locator(`button[title="Settings (${MOD_LABEL}+,)"]`).click();
    await expect(authorInput(page)).toHaveValue('PersistentUser');
  });

  test('author badge in toolbar shows current author', async ({ page }) => {
    await openFixture(page);

    // The default author "User" should be shown in the toolbar
    await expect(page.locator('button', { hasText: 'User' }).first()).toBeVisible();
  });
});
