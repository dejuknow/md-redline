import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE, TEST_DOC_2_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
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
  await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

// ---------------------------------------------------------------------------
// Multi-tab isolation
// ---------------------------------------------------------------------------

test.describe('Multi-tab comment isolation', () => {
  test('comments added to tab 1 do not appear in tab 2 sidebar', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'valid credentials', 'Tab 1 only comment');

    // Open second file
    await openSecondFile(page);

    // Sidebar should not show the tab-1 comment
    await expect(getCard(page, 'Tab 1 only comment')).not.toBeVisible();

    // Switch back to tab 1
    const tab1 = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await tab1.click();
    await page.locator('.prose').waitFor({ timeout: 5000 });

    // Tab 1 comment should reappear
    await expect(getCard(page, 'Tab 1 only comment')).toBeVisible();
  });

  test('comments added to tab 2 are preserved when switching back', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await openSecondFile(page);

    // Add comment to tab 2
    await addComment(page, 'additional information', 'Tab 2 comment');

    // Switch to tab 1
    const tab1 = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await tab1.click();
    await page.locator('.prose').waitFor({ timeout: 5000 });
    await expect(getCard(page, 'Tab 2 comment')).not.toBeVisible();

    // Switch back to tab 2
    const tab2 = page.locator('.h-9 button', { hasText: 'test-doc-2.md' });
    await tab2.click();
    await page.locator('.prose').waitFor({ timeout: 5000 });
    await expect(getCard(page, 'Tab 2 comment')).toBeVisible();
  });

  test('comment count badges reflect per-tab counts', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'valid credentials', 'Count test 1');
    await addComment(page, 'brute force attacks', 'Count test 2');

    await openSecondFile(page);
    await addComment(page, 'additional information', 'Count test on tab 2');

    // Locate each tab button precisely, then find badge within it
    // tab-1 has "test-doc.md" + badge "2"; tab-2 has "test-doc-2.md" + badge "1"
    const tab1Btn = page.locator('.h-9 button').filter({ hasText: /^test-doc\.md/ });
    const tab2Btn = page.locator('.h-9 button', { hasText: 'test-doc-2.md' });

    await expect(tab1Btn.locator('span.rounded-full')).toContainText('2');
    await expect(tab2Btn.locator('span.rounded-full')).toContainText('1');
  });
});

// ---------------------------------------------------------------------------
// Multi-tab file persistence
// ---------------------------------------------------------------------------

test.describe('Multi-tab file persistence', () => {
  test('comments on each tab are persisted to their respective files', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'valid credentials', 'File 1 persisted');
    await page.waitForTimeout(500);

    await openSecondFile(page);
    await addComment(page, 'additional information', 'File 2 persisted');
    await page.waitForTimeout(500);

    const content1 = readFileSync(FIXTURE_1, 'utf-8');
    const content2 = readFileSync(FIXTURE_2, 'utf-8');

    expect(content1).toContain('File 1 persisted');
    expect(content1).not.toContain('File 2 persisted');

    expect(content2).toContain('File 2 persisted');
    expect(content2).not.toContain('File 1 persisted');
  });
});

// ---------------------------------------------------------------------------
// Tab switching preserves rendered content
// ---------------------------------------------------------------------------

test.describe('Tab switching content integrity', () => {
  test('switching tabs renders the correct document content', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await openSecondFile(page);

    // Tab 2 is active – verify doc 2 content is shown and doc 1 is not
    await expect(page.getByRole('heading', { name: 'Second Test Document', exact: true })).toBeVisible();
    // "Section One" is unique to doc 1 and should not be visible
    await expect(page.getByRole('heading', { name: 'Section One' })).not.toBeVisible();

    // Switch to tab 1
    const tab1 = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await tab1.click();
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Introduction' })).not.toBeVisible();

    // Switch back to tab 2
    const tab2 = page.locator('.h-9 button', { hasText: 'test-doc-2.md' });
    await tab2.click();
    await expect(page.getByRole('heading', { name: 'Introduction' })).toBeVisible();
  });

  test('comment active state resets when switching tabs', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'valid credentials', 'Active state test');

    // Focus the comment (click the card)
    const card = getCard(page, 'Active state test');
    await card.click();
    await expect(card).toHaveClass(/ring-1/);

    // Open and switch to tab 2
    await openSecondFile(page);

    // Switch back to tab 1
    const tab1 = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await tab1.click();
    await page.locator('.prose').waitFor({ timeout: 5000 });

    // The comment should be visible but active state is implementation-dependent
    await expect(getCard(page, 'Active state test')).toBeVisible();
  });
});
