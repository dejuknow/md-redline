/**
 * Regression tests for highlight seam artifacts.
 *
 * When a comment's anchor spans an inline element boundary (e.g. <strong>),
 * naive per-node wrapping creates two adjacent <mark> elements with a visible
 * seam between them. The fix groups wraps by block parent and merges wraps
 * within the same block into a single <mark> with plain text.
 *
 * These tests verify that:
 * 1. A comment spanning bold→regular text within one <li> produces one <mark>
 * 2. A comment spanning multiple <li> elements produces one <mark> per <li>,
 *    each without an internal <strong> boundary
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/highlight-seam-doc.md');
const FIXTURE_ORIGINAL = readFileSync(FIXTURE, 'utf-8');

test.beforeEach(async () => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
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
    const container = document.querySelector('.prose') || document.body;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) textNodes.push(n);

    // Build concatenated text to find the match across element boundaries
    const fullText = textNodes.map((t) => t.textContent || '').join('');
    const matchStart = fullText.indexOf(targetText);
    if (matchStart === -1) throw new Error(`Text "${targetText}" not found in rendered markdown`);
    const matchEnd = matchStart + targetText.length;

    // Find which text nodes the match spans
    let pos = 0;
    let startNode: Text | null = null, startOffset = 0;
    let endNode: Text | null = null, endOffset = 0;
    for (const tn of textNodes) {
      const len = tn.textContent?.length || 0;
      if (!startNode && pos + len > matchStart) {
        startNode = tn;
        startOffset = matchStart - pos;
      }
      if (pos + len >= matchEnd) {
        endNode = tn;
        endOffset = matchEnd - pos;
        break;
      }
      pos += len;
    }
    if (!startNode || !endNode) throw new Error(`Could not build range for "${targetText}"`);

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const rect = range.getBoundingClientRect();
    (startNode.parentElement || container).dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
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

test.describe('highlight seam regression', () => {
  test('comment spanning bold+regular text in one li produces a single mark', async ({ page }) => {
    await openFixture(page);

    // Select text that crosses the <strong> boundary: "bold text: followed"
    await addComment(page, 'bold text: followed', 'single-li seam test');

    // Click the comment to activate it
    await page.getByText('single-li seam test').click();
    await page.waitForTimeout(300);

    // Find the block element containing the highlight and check mark structure
    const markStructure = await page.evaluate(() => {
      const container = Array.from(document.querySelectorAll('p'))
        .find(el => el.textContent?.includes('bold text'));
      if (!container) return null;

      const marks = container.querySelectorAll('mark.comment-highlight');
      return {
        markCount: marks.length,
        marksWithStrong: Array.from(marks).filter(m => m.querySelector('strong')).length,
        markTexts: Array.from(marks).map(m => m.textContent),
      };
    });

    // Should be exactly 1 mark (merged), not 2 (split by <strong>)
    expect(markStructure).not.toBeNull();
    expect(markStructure!.markCount).toBe(1);
    expect(markStructure!.marksWithStrong).toBe(0);
    expect(markStructure!.markTexts[0]).toContain('bold text');
    expect(markStructure!.markTexts[0]).toContain('followed');
  });

  test('comment spanning multiple li elements produces one mark per li without seams', async ({ page }) => {
    await openFixture(page);

    // Select text spanning the first two Metric bullets
    await addComment(
      page,
      'Metric: 30% increase in average knowledge entries per application.',
      'cross-li seam test',
    );

    await page.getByText('cross-li seam test').click();
    await page.waitForTimeout(300);

    // Check mark structure in the li that has "30% increase"
    const markStructure = await page.evaluate(() => {
      const targetLi = Array.from(document.querySelectorAll('li'))
        .find(el => el.textContent?.includes('30% increase'));
      if (!targetLi) return { error: 'target li not found' };

      const marks = targetLi.querySelectorAll('mark.comment-highlight');
      return {
        markCount: marks.length,
        marksWithStrong: Array.from(marks).filter(m => m.querySelector('strong')).length,
        markTexts: Array.from(marks).map(m => m.textContent),
        // Verify no <strong> is a parent of any mark (the per-node seam pattern)
        marksInsideStrong: Array.from(marks).filter(m => m.parentElement?.tagName === 'STRONG').length,
      };
    });

    // Even though the comment spans multiple <li>s, each <li> should have
    // at most 1 mark for this comment (merged across the <strong> boundary)
    expect(markStructure.markCount).toBe(1);
    expect(markStructure.marksWithStrong).toBe(0);
    expect(markStructure.marksInsideStrong).toBe(0);
  });
});
