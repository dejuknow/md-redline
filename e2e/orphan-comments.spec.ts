import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');

const FIXTURE = `# Orphan Test

Sentence one with the original anchor phrase inside it.

Sentence two holds a fresh landing spot for recovery.
`;

let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `orphan-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'orphan.md');
  writeFileSync(fixturePath, FIXTURE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Orphan Test' })).toBeVisible({
    timeout: 10_000,
  });
  // Allow the SSE file-watcher connection to establish before making disk changes.
  await page.waitForTimeout(500);
}

async function selectText(page: Page, text: string, occurrence = 0) {
  await page.evaluate(
    ([targetText, occurrenceIndex]: [string, number]) => {
      const walker = document.createTreeWalker(
        document.querySelector('.prose') || document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node: Text | null;
      let found = 0;
      while ((node = walker.nextNode() as Text | null)) {
        const content = node.textContent ?? '';
        let searchFrom = 0;
        let idx: number;
        while ((idx = content.indexOf(targetText, searchFrom)) >= 0) {
          if (found === occurrenceIndex) {
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
          found++;
          searchFrom = idx + 1;
        }
      }
      throw new Error(
        `Text "${targetText}" occurrence ${occurrenceIndex} not found in rendered markdown`,
      );
    },
    [text, occurrence] as [string, number],
  );
}

async function addComment(page: Page, anchor: string, text: string) {
  await selectText(page, anchor);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(text);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test('comment whose anchor disappears moves into Needs re-anchoring section', async ({ page }) => {
  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');

  // Wait for the addComment save to land on disk before doing the external
  // rewrite, so readFileSync picks up the version that has the comment marker.
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  // The external rewrite replaces the first occurrence of "original anchor phrase"
  // in the raw file.  The comment marker is placed BEFORE the anchor text, so
  // the first occurrence is inside the JSON ("anchor":"original anchor phrase").
  // This changes the anchor field to "totally different wording" while leaving
  // the visible rendered text unchanged, making the comment an orphan.
  const currentRaw = readFileSync(fixturePath, 'utf8');
  const rewritten = currentRaw.replace('original anchor phrase', 'totally different wording');
  writeFileSync(fixturePath, rewritten);

  await expect(page.getByText('Needs re-anchoring (1)')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Was anchored here:')).toBeVisible();
  await expect(page.getByText('original anchor phrase').first()).toBeVisible();

  await expect(
    page.getByText(/comment lost its anchor/i).or(page.getByText(/comments lost their anchor/i)),
  ).toBeVisible({ timeout: 7000 });
});

test('Re-anchor to selection binds the orphan comment to new text', async ({ page }) => {
  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');

  // Wait for the addComment save to land on disk before doing the external
  // rewrite, so readFileSync picks up the version that has the comment marker.
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(
    fixturePath,
    currentRaw.replace('original anchor phrase', 'totally different wording'),
  );
  await expect(page.getByText('Needs re-anchoring (1)')).toBeVisible({ timeout: 5000 });

  // Click the CommentCard inside the orphan wrapper to activate it.
  // The ring-1 active class lives on the inner .group div, not the data-orphan wrapper.
  await page.locator('[data-orphan="true"] .group').first().click();
  await expect(
    page.locator('[data-orphan="true"] .group').first(),
  ).toHaveClass(/ring-1/, { timeout: 2000 });

  // Select the new landing text.
  await selectText(page, 'fresh landing spot');

  const reanchorBtn = page.getByRole('button', { name: 'Re-anchor to selection' });
  await expect(reanchorBtn).toBeVisible({ timeout: 2000 });

  // Use a programmatic click to avoid the mousedown/mouseup sequence that
  // clears the browser text selection before React's onClick fires.  A normal
  // Playwright click dispatches mousedown first, which causes the browser to
  // collapse the text selection; by the time the React onClick handler reads
  // selectionText from props, a re-render triggered by the document mouseup
  // listener (useSelection) has already set selection to null.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Re-anchor to selection'),
    );
    btn?.click();
  });

  await expect(page.getByText('Needs re-anchoring')).not.toBeVisible({ timeout: 5000 });

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('"anchor":"fresh landing spot"');
});

test('Re-anchor to selection picks the selected occurrence when anchor text is duplicated', async ({ page }) => {
  // Use a fixture where "landing spot" appears twice so we can test that
  // hintOffset routes re-anchoring to the actually-selected occurrence.
  const DUP_FIXTURE = `# Orphan Test

Sentence one with the original anchor phrase inside it.

First landing spot sits here. Second landing spot sits farther down for selection.
`;
  writeFileSync(fixturePath, DUP_FIXTURE);

  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 3000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(
    fixturePath,
    currentRaw.replace('original anchor phrase', 'totally different wording'),
  );
  await expect(page.getByText('Needs re-anchoring (1)')).toBeVisible({ timeout: 5000 });

  // Activate the orphan card.
  await page.locator('[data-orphan="true"] .group').first().click();
  await expect(
    page.locator('[data-orphan="true"] .group').first(),
  ).toHaveClass(/ring-1/, { timeout: 2000 });

  // Select the SECOND occurrence of "landing spot" (occurrence index 1).
  await selectText(page, 'landing spot', 1);

  const reanchorBtn = page.getByRole('button', { name: 'Re-anchor to selection' });
  await expect(reanchorBtn).toBeVisible({ timeout: 2000 });
  // Click programmatically to avoid mousedown clearing the selection.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Re-anchor to selection',
    ) as HTMLButtonElement | undefined;
    btn?.click();
  });

  await expect(page.getByText('Needs re-anchoring')).not.toBeVisible({ timeout: 3000 });

  // With hintOffset threaded correctly, moveComment resolves to the SECOND
  // occurrence. Its contextBefore should include "Second ".
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 3000 })
    .toMatch(/"contextBefore":"[^"]*Second [^"]*"/);
});
