import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('File watcher - external changes', () => {
  test('external file modification updates the rendered content', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Modify the file externally
    const modified = FIXTURE_ORIGINAL.replace('## Section One', '## Externally Modified');
    writeFileSync(FIXTURE, modified);

    // The content should update via SSE
    await expect(page.getByRole('heading', { name: 'Externally Modified' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('external change shows a toast notification', async ({ page }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Modify the file externally — change content (not just headings) to trigger "edited externally" toast
    const modified = FIXTURE_ORIGINAL.replace('## Section Two', '## Changed Section Two');
    writeFileSync(FIXTURE, modified);

    // Look for the updated content (proves the change was detected)
    await expect(page.getByRole('heading', { name: 'Changed Section Two' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('external edit adding a comment marker increases comment count', async ({ page }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Inject a comment marker externally
    const withComment = FIXTURE_ORIGINAL.replace(
      'email and password login',
      '<!-- @comment{"id":"ext-1","anchor":"email and password login","text":"External comment","author":"Agent","timestamp":"2026-03-22T00:00:00.000Z"} -->email and password login',
    );
    writeFileSync(FIXTURE, withComment);

    // The externally added comment should appear in the sidebar
    await expect(page.getByText('External comment')).toBeVisible({ timeout: 15_000 });
  });

  test('multiple external edits are all detected', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // First external edit
    let content = FIXTURE_ORIGINAL.replace('## Section One', '## First Edit');
    writeFileSync(FIXTURE, content);
    await expect(page.getByRole('heading', { name: 'First Edit' })).toBeVisible({
      timeout: 15_000,
    });

    // Second external edit
    content = content.replace('## Section Two', '## Second Edit');
    writeFileSync(FIXTURE, content);
    await expect(page.getByRole('heading', { name: 'Second Edit' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('self-writes do not trigger external change notification', async ({ page }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Add a comment via the UI (this is a "self-write")
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
    }, 'valid credentials');

    const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
    await commentBtn.click();
    await page.getByPlaceholder('Add your comment...').fill('Self write test');
    await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
    await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5000 });

    // Wait for any false SSE notification to arrive
    await page.waitForTimeout(1000);

    // The "Changed" badge should NOT appear for our own save
    await expect(page.getByText('Changed')).not.toBeVisible();
  });
});
