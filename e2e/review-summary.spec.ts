import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

async function openSecondFile(page: Page) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(FIXTURE_2);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({ timeout: 10_000 });
}

const summaryBtn = (page: Page) =>
  page.locator('button[title="Review summary across files"]');

// ---------------------------------------------------------------------------
// Review summary tests
// ---------------------------------------------------------------------------

/** Scope assertions to the review summary popover. */
const popover = (page: Page) => page.locator('.absolute.top-12.right-4');

test.describe('Review summary', () => {
  test('summary popover opens and shows heading', async ({ page }) => {
    await openFixture(page);

    await summaryBtn(page).click();

    await expect(popover(page).getByText('Review Summary')).toBeVisible();
  });

  test('summary shows comment count for single file', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Summary test 1');
    await addComment(page, 'brute force attacks', 'Summary test 2');

    await summaryBtn(page).click();

    // Should show "2 comments across 1 file"
    await expect(popover(page).getByText('2 comments across 1 file')).toBeVisible();

    // Should show the file name inside the popover
    await expect(popover(page).getByText('test-doc.md')).toBeVisible();
  });

  test('summary shows counts across multiple files', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'File 1 comment');

    await openSecondFile(page);
    await addComment(page, 'additional information', 'File 2 comment');

    await summaryBtn(page).click();

    await expect(popover(page).getByText('2 comments across 2 files')).toBeVisible();
    await expect(popover(page).getByText('test-doc.md')).toBeVisible();
    await expect(popover(page).getByText('test-doc-2.md')).toBeVisible();
  });

  test('clicking a file in the summary switches to it', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Navigate comment');

    await openSecondFile(page);
    // Now we're on file 2

    await summaryBtn(page).click();

    // Click on test-doc.md in the popover to switch to it
    await popover(page).locator('button', { hasText: 'test-doc.md' }).click();

    // Should switch to the first file
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
  });

  test('summary shows "No comments" for files without comments', async ({ page }) => {
    await openFixture(page);

    await summaryBtn(page).click();

    await expect(popover(page).getByText('No comments')).toBeVisible();
  });
});
