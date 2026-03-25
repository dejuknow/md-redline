import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = readFileSync(FIXTURE, 'utf-8');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
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
// Diff view tests
// ---------------------------------------------------------------------------

test.describe('Diff view', () => {
  test('take snapshot button appears and switches title after taking snapshot', async ({ page }) => {
    await openFixture(page);

    // Initially shows "Take diff snapshot"
    const snapshotBtn = page.locator('button[title="Take diff snapshot"]');
    await expect(snapshotBtn).toBeVisible();

    await snapshotBtn.click();

    // After taking snapshot, button title changes to "Update diff snapshot"
    await expect(page.locator('button[title="Update diff snapshot"]')).toBeVisible();
  });

  test('diff view shows "No changes" when content matches snapshot', async ({ page }) => {
    await openFixture(page);

    // Take a snapshot
    await page.locator('button[title="Take diff snapshot"]').click();

    // Switch to diff view
    await page.locator('button[title="View diff since snapshot"]').click();

    // Should show "No changes detected"
    await expect(page.getByText('No changes detected')).toBeVisible();
  });

  test('diff view shows changes after external file edit', async ({ page }) => {
    await openFixture(page);

    // Take a snapshot of the original content
    await page.locator('button[title="Take diff snapshot"]').click();
    await expect(page.locator('button[title="Update diff snapshot"]')).toBeVisible();

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Modify the file externally — this triggers SSE reload
    const modified = FIXTURE_ORIGINAL.replace(
      '## Section One',
      '## Updated Section',
    );
    writeFileSync(FIXTURE, modified);

    // The app auto-switches to diff view when an external change is detected
    // and a snapshot exists. Verify the diff content shows both old and new.
    // The removed line "-" and added line "+" should both be visible.
    await expect(page.getByText('## Updated Section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('## Section One')).toBeVisible();

    // The "Switch to rendered view" button confirms we're in diff view
    await expect(page.locator('button[title="Switch to rendered view"]')).toBeVisible();
  });

  test('diff view toggle switches back to rendered view', async ({ page }) => {
    await openFixture(page);

    // Take snapshot and switch to diff
    await page.locator('button[title="Take diff snapshot"]').click();
    await page.locator('button[title="View diff since snapshot"]').click();
    await expect(page.getByText('No changes detected')).toBeVisible();

    // Switch back to rendered
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('.prose')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();
  });

  test('diff view is not available before taking a snapshot', async ({ page }) => {
    await openFixture(page);

    // The diff toggle button should not be present before any snapshot
    const diffBtn = page.locator('button[title="View diff since snapshot"]');
    await expect(diffBtn).not.toBeVisible();
  });
});
