/**
 * Regression tests for dragging the START handle backwards across formatting
 * boundaries. The root cause: updateCommentAnchor only changes the anchor text
 * but doesn't move the comment marker. wrapText then searches for the expanded
 * anchor near cleanOffset, but the anchor now starts well before that position
 * because (a) the anchor grew leftward and (b) markdown formatting characters
 * (**, *, ##) inflate cleanOffset relative to the rendered text position.
 *
 * The fix widens wrapText's search window to use the anchor text length.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FORMATTED_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/formatted-doc.md');
const FIXTURE_ORIGINAL = FORMATTED_DOC_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await resetTestAppState(page);
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

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

/**
 * Drag the start handle leftward by a given pixel offset.
 */
async function dragStartHandleLeft(page: Page, pxLeft: number) {
  const startHandle = page.locator('[data-drag-handle]').first();
  const box = await startHandle.boundingBox();
  expect(box).not.toBeNull();

  await startHandle.hover();
  await page.mouse.down();
  await page.mouse.move(box!.x - pxLeft, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();

  // Wait for the anchor change to save and re-render
  await page.waitForTimeout(800);
}

// ---------------------------------------------------------------------------
// Regression: dragging start handle backwards across formatting boundary
// ---------------------------------------------------------------------------

test.describe('Drag start handle backwards - regression', () => {
  test('dragging start handle left past bold formatting keeps highlight visible', async ({
    page,
  }) => {
    await openFixture(page);

    // Comment on text AFTER all the formatting
    await addComment(page, 'followed by regular text', 'Bold boundary test');

    const card = getCard(page, 'Bold boundary test');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    // Drag the start handle far left — past multiple formatting boundaries
    await dragStartHandleLeft(page, 300);

    // The highlight MUST still exist after the state update and re-render
    const highlights = page.locator('mark.comment-highlight');
    await expect(highlights.first()).toBeVisible({ timeout: 5000 });

    // The anchor should have expanded
    const anchorPreview = card.locator('.font-mono').first();
    const anchorText = await anchorPreview.textContent();
    const cleanAnchor = anchorText?.replace(/["\u201C\u201D]/g, '').trim() ?? '';
    expect(cleanAnchor.length).toBeGreaterThan('followed by regular text'.length);
  });

  test('highlight survives page reload after large backward expansion', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'followed by regular text', 'Persist after large drag');

    const card = getCard(page, 'Persist after large drag');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    // Large backward drag
    await dragStartHandleLeft(page, 400);

    // Verify highlight exists before reload
    await expect(page.locator('mark.comment-highlight').first()).toBeVisible({ timeout: 5000 });

    // Reload forces full re-parse + re-render through wrapText
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    // Highlight must survive the reload
    await expect(page.locator('mark.comment-highlight').first()).toBeVisible({ timeout: 5000 });
  });

  test('dragging start handle across paragraph boundary keeps highlight', async ({ page }) => {
    await openFixture(page);

    // Comment on text in the second paragraph of "Cross Paragraph Section"
    await addComment(page, 'target text we want', 'Cross paragraph drag test');

    const card = getCard(page, 'Cross paragraph drag test');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    // Drag the start handle upward and left — across the paragraph boundary
    const startHandle = page.locator('[data-drag-handle]').first();
    const box = await startHandle.boundingBox();
    expect(box).not.toBeNull();

    await startHandle.hover();
    await page.mouse.down();
    // Move up (cross paragraph) and left
    await page.mouse.move(box!.x - 100, box!.y - 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);

    // Highlight should still be visible
    const highlights = page.locator('mark.comment-highlight');
    await expect(highlights.first()).toBeVisible({ timeout: 5000 });
  });

  test('dragging start handle left past italic formatting keeps highlight visible', async ({
    page,
  }) => {
    await openFixture(page);

    await addComment(page, 'and then normal text', 'Italic boundary test');

    const card = getCard(page, 'Italic boundary test');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    await dragStartHandleLeft(page, 200);

    const highlights = page.locator('mark.comment-highlight');
    await expect(highlights.first()).toBeVisible({ timeout: 5000 });
  });
});
