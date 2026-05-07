import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TABLE_DUPLICATES_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `table-dup-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'table-duplicates-doc.md');
  writeFileSync(fixturePath, TABLE_DUPLICATES_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Table Duplicates Test' })).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Select the Nth occurrence of `targetText` in the rendered prose. Used to
 * disambiguate duplicates that share an exact string (e.g. `duration_seconds`
 * in two different table rows).
 */
async function selectNthOccurrence(page: Page, targetText: string, occurrenceIndex: number) {
  await page.evaluate(
    ({ targetText, occurrenceIndex }) => {
      const root = document.querySelector('.prose') ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      let seen = 0;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent ?? '';
        let from = 0;
        while (true) {
          const idx = text.indexOf(targetText, from);
          if (idx < 0) break;
          if (seen === occurrenceIndex) {
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
          seen += 1;
          from = idx + 1;
        }
      }
      throw new Error(
        `Occurrence ${occurrenceIndex} of "${targetText}" not found (only ${seen} found)`,
      );
    },
    { targetText, occurrenceIndex },
  );
}

async function addCommentAtNthOccurrence(
  page: Page,
  anchorText: string,
  occurrenceIndex: number,
  commentText: string,
) {
  await selectNthOccurrence(page, anchorText, occurrenceIndex);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5000 });
}

test.describe('Duplicate anchors inside table cells', () => {
  test('comment on the SECOND duration_seconds (in build_completed row) anchors to that row, not the first table', async ({
    page,
  }) => {
    await openFixture(page);

    // The fixture has `duration_seconds` in two rows of two different tables:
    //   1) section 2 — onboarding_completed row
    //   2) section 3 — build_completed row
    // Selecting the SECOND occurrence and commenting should anchor to row #2.
    await addCommentAtNthOccurrence(
      page,
      'duration_seconds',
      1,
      'remove duration tracking from build_completed',
    );

    // Read the file from disk and verify the marker is in the build_completed row.
    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('remove duration tracking from build_completed');

    const content = readFileSync(fixturePath, 'utf-8');

    // The marker must be placed BEFORE the build_completed row's duration_seconds,
    // not before the onboarding_completed row's duration_seconds.
    const markerIdx = content.indexOf('"text":"remove duration tracking from build_completed"');
    expect(markerIdx).toBeGreaterThan(-1);

    const onboardingRowIdx = content.indexOf('| `onboarding_completed`');
    const buildCompletedRowIdx = content.indexOf('| `build_completed`');
    expect(onboardingRowIdx).toBeGreaterThan(-1);
    expect(buildCompletedRowIdx).toBeGreaterThan(onboardingRowIdx);

    // Marker must land between the build_completed row start and the next row.
    expect(markerIdx).toBeGreaterThan(buildCompletedRowIdx);

    const setupStartedRowIdx = content.indexOf('| `setup_started`');
    expect(markerIdx).toBeLessThan(setupStartedRowIdx);
  });
});
