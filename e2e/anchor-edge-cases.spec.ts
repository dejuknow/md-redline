import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ANCHOR_EDGE_CASES_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `anchor-edges-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'anchor-edge-cases-doc.md');
  writeFileSync(fixturePath, ANCHOR_EDGE_CASES_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Anchor Edge Cases' })).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Build a DOM Range that spans `startText` … `endText` inside the rendered
 * markdown. The range starts at the first occurrence of `startText` and ends
 * at the end of the first occurrence of `endText` after that. Used for
 * cross-element selections (e.g. multiple bullets in a blockquote).
 */
async function selectFromTo(page: Page, startText: string, endText: string) {
  await page.evaluate(
    ({ startText, endText }) => {
      const root = document.querySelector('.prose') ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (!startNode) {
          const idx = node.textContent?.indexOf(startText) ?? -1;
          if (idx >= 0) {
            startNode = node;
            startOffset = idx;
          }
        }
        if (startNode) {
          const idx = node.textContent?.indexOf(endText) ?? -1;
          if (idx >= 0) {
            endNode = node;
            endOffset = idx + endText.length;
            break;
          }
        }
      }
      if (!startNode || !endNode) {
        throw new Error(
          `Could not build range "${startText}" … "${endText}" (start=${!!startNode}, end=${!!endNode})`,
        );
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const rect = range.getBoundingClientRect();
      endNode.parentElement?.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom - 2,
        }),
      );
    },
    { startText, endText },
  );
}

async function selectSingleText(page: Page, text: string) {
  await page.evaluate((target) => {
    const root = document.querySelector('.prose') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.textContent?.indexOf(target) ?? -1;
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + target.length);
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
    throw new Error(`Text "${target}" not found in rendered markdown`);
  }, text);
}

async function submitCommentForm(page: Page, body: string) {
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(body);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5000 });
}

test.describe('Comments anchor cleanly across markdown constructs', () => {
  test('blockquoted task list', async ({ page }) => {
    await openFixture(page);
    await selectFromTo(page, 'First item to address', 'Third item still pending');
    await submitCommentForm(page, 'check the launch checklist');

    await expect(page.getByText('check the launch checklist')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('inline HTML kbd tags', async ({ page }) => {
    await openFixture(page);
    // Selection crosses multiple text nodes (text + `<kbd>` + text + `<kbd>` + text)
    await selectFromTo(page, 'Press', 'to copy the selection.');
    await submitCommentForm(page, 'simplify the keyboard hint');

    await expect(page.getByText('simplify the keyboard hint')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('reference-style link span', async ({ page }) => {
    await openFixture(page);
    // Selection spans `[the docs][docs]` + " and " + `[the spec][spec]`
    await selectFromTo(page, 'See', 'for full details.');
    await submitCommentForm(page, 'fold these into a single link');

    await expect(page.getByText('fold these into a single link')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('escaped characters in prose', async ({ page }) => {
    await openFixture(page);
    await selectSingleText(page, 'Use *literal asterisks* not bold');
    await submitCommentForm(page, 'this paragraph escapes asterisks');

    await expect(page.getByText('this paragraph escapes asterisks')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });
});
