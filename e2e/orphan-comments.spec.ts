import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');

// The anchored sentence sits LAST on purpose. A marker only becomes a true
// orphan when there is nothing after it to recover from: a marker still
// followed by text re-anchors to that text by position and gets the quiet
// "Re-anchored" badge instead. Deleting the trailing sentence strands the
// marker at end of file, while the landing spot survives above it for the
// re-anchor flow to target.
const FIXTURE = `# Orphan Test

Sentence two holds a fresh landing spot for recovery.

Sentence one with the original anchor phrase inside it.
`;

/** The body text an external rewrite deletes to strand the marker. */
const ANCHORED_SENTENCE_TAIL = 'original anchor phrase inside it.';

let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(TEMP_FIXTURE_DIR, `orphan-${process.pid}-${testInfo.retry}-${Date.now()}`);
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
            // Keep the anchor on-screen so the pill isn't hidden by its
            // anchorOffscreen guard (see helpers/comments.ts selectText).
            node.parentElement?.scrollIntoView({ block: 'nearest' });
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

/**
 * The "Needs re-anchoring" divider and the "Was anchored here" / "Re-anchor
 * to selection" context UI only render on CommentListSurface (List density
 * or the drawer); the default Anchored density's margin cards just show a
 * compact "Changed" badge with no context. Switch density before orphan
 * assertions so they target a surface where that UI actually exists.
 */
async function switchToListDensity(page: Page) {
  await page.locator('[data-rail-header] button', { hasText: 'List' }).click();
}

test('comment whose anchor disappears moves into Needs re-anchoring section', async ({ page }) => {
  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');
  await switchToListDensity(page);

  // Wait for the addComment save to land on disk before doing the external
  // rewrite, so readFileSync picks up the version that has the comment marker.
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  // Delete the anchored text outright. The marker is written immediately
  // before it and is the last thing in the file, so nothing follows it to
  // recover from and the comment orphans for real.
  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(fixturePath, currentRaw.replace(ANCHORED_SENTENCE_TAIL, ''));

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
  await switchToListDensity(page);

  // Wait for the addComment save to land on disk before doing the external
  // rewrite, so readFileSync picks up the version that has the comment marker.
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(fixturePath, currentRaw.replace(ANCHORED_SENTENCE_TAIL, ''));
  await expect(page.getByText('Needs re-anchoring (1)')).toBeVisible({ timeout: 5000 });

  // The natural flow: select replacement text first, then click Re-anchor.
  // The button must be reachable without first activating the orphan card
  // (activating would require a click outside the viewer, which collapses
  // the selection before the user could pick new text).
  await selectText(page, 'fresh landing spot');

  const reanchorBtn = page.getByRole('button', { name: 'Re-anchor to selection' });
  await expect(reanchorBtn).toBeVisible({ timeout: 2000 });
  await reanchorBtn.click();

  await expect(page.getByText('Needs re-anchoring')).not.toBeVisible({ timeout: 5000 });

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('"anchor":"fresh landing spot"');
});

test('Re-anchor to selection picks the selected occurrence when anchor text is duplicated', async ({
  page,
}) => {
  // Use a fixture where "landing spot" appears twice so we can test that
  // hintOffset routes re-anchoring to the actually-selected occurrence.
  // Anchored sentence last, for the same reason as the shared FIXTURE.
  const DUP_FIXTURE = `# Orphan Test

First landing spot sits here. Second landing spot sits farther down for selection.

Sentence one with the original anchor phrase inside it.
`;
  writeFileSync(fixturePath, DUP_FIXTURE);

  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');
  await switchToListDensity(page);

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 3000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(fixturePath, currentRaw.replace(ANCHORED_SENTENCE_TAIL, ''));
  await expect(page.getByText('Needs re-anchoring (1)')).toBeVisible({ timeout: 5000 });

  // Select the SECOND occurrence of "landing spot" (occurrence index 1)
  // without first activating the card.
  await selectText(page, 'landing spot', 1);

  const reanchorBtn = page.getByRole('button', { name: 'Re-anchor to selection' });
  await expect(reanchorBtn).toBeVisible({ timeout: 2000 });
  await reanchorBtn.click();

  await expect(page.getByText('Needs re-anchoring')).not.toBeVisible({ timeout: 3000 });

  // With hintOffset threaded correctly, moveComment resolves to the SECOND
  // occurrence. Its contextBefore should include "Second ".
  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 3000 })
    .toMatch(/"contextBefore":"[^"]*Second [^"]*"/);
});

test('a rewritten anchor re-anchors by position instead of orphaning', async ({ page }) => {
  // The failure this exists for: an agent addresses comments by restructuring
  // the document, so every anchor quoting the old prose stops existing at once.
  // The markers survive in place, so the text that replaced the prose is right
  // there after them.
  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');
  await switchToListDensity(page);

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(
    fixturePath,
    currentRaw.replace(ANCHORED_SENTENCE_TAIL, 'a completely rewritten decision item.'),
  );

  // Attached, not orphaned: no re-anchoring section, and the card quotes where
  // the comment now points.
  await expect(page.getByText('Re-anchored')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Needs re-anchoring')).not.toBeVisible();
  // Scoped to the card's own quote element. Matching the page at large would
  // pass on the rendered document body, which contains this sentence whether
  // or not the card ever followed the recovery.
  await expect(page.locator('[data-anchor-quote]').first()).toContainText(
    'a completely rewritten decision item.',
  );

  // Recovery is a display aid. The stored anchor is untouched on disk, so the
  // reviewer's original words survive and re-anchoring stays their decision.
  expect(readFileSync(fixturePath, 'utf8')).toContain('"anchor":"original anchor phrase"');
  expect(readFileSync(fixturePath, 'utf8')).not.toContain('recoveredAnchor');
});

test('Keep this anchor writes the recovered anchor into the file', async ({ page }) => {
  // Without this, a recovered comment is the one detached state with no way
  // out: excluded from "Needs re-anchoring", so it never gets the re-anchor
  // button, and the stale anchor sits in the file permanently.
  await openFixture(page);
  await addComment(page, 'original anchor phrase', 'note about phrase');
  await switchToListDensity(page);

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('@comment');

  const currentRaw = readFileSync(fixturePath, 'utf8');
  writeFileSync(
    fixturePath,
    currentRaw.replace(ANCHORED_SENTENCE_TAIL, 'a completely rewritten decision item.'),
  );
  await expect(page.getByText('Re-anchored')).toBeVisible({ timeout: 5000 });

  await page.getByText('note about phrase').click();
  const keepBtn = page.getByRole('button', { name: 'Keep this anchor' });
  await expect(keepBtn).toBeVisible({ timeout: 3000 });
  await keepBtn.click();

  await expect
    .poll(() => readFileSync(fixturePath, 'utf8'), { timeout: 5000 })
    .toContain('"anchor":"a completely rewritten decision item."');

  // The recovery is spent: the anchor now resolves on its own, so the badge
  // that invited the click is gone.
  await expect(page.getByText('Re-anchored')).not.toBeVisible();
});
