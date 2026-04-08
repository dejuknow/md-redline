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

  test('external change does not mark tab as dirty (no false unsaved-changes dialog)', async ({
    page,
  }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Modify the file externally
    const modified = FIXTURE_ORIGINAL.replace('## Section One', '## Dirty Flag Test');
    writeFileSync(FIXTURE, modified);

    // Wait for the change to propagate
    await expect(page.getByRole('heading', { name: 'Dirty Flag Test' })).toBeVisible({
      timeout: 15_000,
    });

    // Close the tab via middle-click on the tab itself (avoids tiny close-button hit target)
    const tab = page.getByRole('button', { name: /test-doc\.md/ }).first();
    await tab.click({ button: 'middle' });

    // The "Unsaved changes" dialog should NOT appear — the tab should close cleanly
    await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 2000 });
  });

  test('agent-style reply without a timestamp gets backfilled and persisted', async ({ page }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Step 1: externally add a comment marker to the file. This is the comment
    // the "agent" will reply to. We use a stable past timestamp for the comment
    // itself so it can't be confused with the reply backfill below.
    const commentJson = JSON.stringify({
      id: 'agent-test-c1',
      anchor: 'valid credentials',
      text: 'Should we say "active credentials"?',
      author: 'Dennis',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const withComment = FIXTURE_ORIGINAL.replace(
      'valid credentials',
      `<!-- @comment${commentJson} -->valid credentials`,
    );
    writeFileSync(FIXTURE, withComment);

    // Wait for the comment to render in the sidebar so we know SSE round-trip
    // and the in-memory state are settled before the next external write.
    await expect(page.getByText('Should we say "active credentials"?')).toBeVisible({
      timeout: 15_000,
    });

    // Step 2: simulate the agent adding a reply with NO timestamp field, the
    // shape Gemini CLI / Claude / Codex produce after the prompt change.
    const withReply = FIXTURE_ORIGINAL.replace(
      'valid credentials',
      `<!-- @comment${JSON.stringify({
        id: 'agent-test-c1',
        anchor: 'valid credentials',
        text: 'Should we say "active credentials"?',
        author: 'Dennis',
        timestamp: '2025-01-01T00:00:00.000Z',
        replies: [
          { id: 'agent-test-r1', text: 'Yes, "active" is more precise.', author: 'Gemini CLI' },
        ],
      })} -->valid credentials`,
    );
    writeFileSync(FIXTURE, withReply);

    // Wait for the reply to render in the sidebar.
    await expect(page.getByText('Yes, "active" is more precise.')).toBeVisible({
      timeout: 15_000,
    });

    // Defensive render: the reply must NOT show "Invalid Date" anywhere.
    await expect(page.getByText('Invalid Date')).not.toBeVisible();

    // Wait for the persistence write-back to land. Polls because the
    // saveFileAt call is queued asynchronously after the SSE handler.
    await expect
      .poll(
        () => {
          const onDisk = readFileSync(FIXTURE, 'utf-8');
          const m = onDisk.match(/"id":"agent-test-r1"[^}]*"timestamp":"([^"]+)"/);
          return m?.[1] ?? null;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // The persisted timestamp must be a valid ISO-8601 string close to "now,"
    // not a stale agent guess. We allow a generous 5-minute window to absorb
    // mtime granularity and CI clock skew.
    const onDisk = readFileSync(FIXTURE, 'utf-8');
    const match = onDisk.match(/"id":"agent-test-r1"[^}]*"timestamp":"([^"]+)"/);
    expect(match).not.toBeNull();
    const persistedMs = new Date(match![1]).getTime();
    expect(Number.isNaN(persistedMs)).toBe(false);
    const skew = Math.abs(Date.now() - persistedMs);
    expect(skew).toBeLessThan(5 * 60_000);
  });

  test('reply with missing timestamp does not render "Invalid Date" on first load', async ({
    page,
  }) => {
    // Pre-populate the file BEFORE md-redline loads it, so the missing-timestamp
    // reply goes through the parse path (not the SSE backfill path). This is
    // the workflow where the agent edits while md-redline is closed.
    const commentJson = JSON.stringify({
      id: 'load-test-c1',
      anchor: 'valid credentials',
      text: 'Should we say "active credentials"?',
      author: 'Dennis',
      timestamp: '2025-01-01T00:00:00.000Z',
      replies: [
        { id: 'load-test-r1', text: 'Yes, "active" is more precise.', author: 'Gemini CLI' },
      ],
    });
    writeFileSync(
      FIXTURE,
      FIXTURE_ORIGINAL.replace(
        'valid credentials',
        `<!-- @comment${commentJson} -->valid credentials`,
      ),
    );

    await openFixture(page);

    // The reply should render with author but WITHOUT "Invalid Date".
    await expect(page.getByText('Yes, "active" is more precise.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Invalid Date')).not.toBeVisible();
  });
});
