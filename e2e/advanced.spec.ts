import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = readFileSync(FIXTURE_1, 'utf-8');
const FIXTURE_2_ORIGINAL = readFileSync(FIXTURE_2, 'utf-8');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
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

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

/** Open a second file via the + tab button and the file input form. */
async function openSecondFile(page: Page) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('/path/to/your/file.md').fill(FIXTURE_2);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// 1. Multi-tab support
// ---------------------------------------------------------------------------

test.describe('Multi-tab support', () => {
  test('open two files in separate tabs and switch between them', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();

    await openSecondFile(page);

    // Both tabs should be visible in the tab bar
    const tabBar = page.locator('.h-9');
    const tab1 = tabBar.locator('button', { hasText: 'test-doc.md' }).first();
    const tab2 = tabBar.locator('button', { hasText: 'test-doc-2.md' });
    await expect(tab1).toBeVisible();
    await expect(tab2).toBeVisible();

    // Switch to first tab
    await tab1.click();
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();

    // Switch back to second tab
    await tab2.click();
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
  });

  test('closing a tab switches to an adjacent tab', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await openSecondFile(page);

    // Close the active (second) tab — the X is a span with an SVG inside
    const tabBar = page.locator('.h-9');
    const tab2 = tabBar.locator('button', { hasText: 'test-doc-2.md' });
    // Click the close span (the one with the SVG X icon)
    await tab2.locator('svg').click();

    // Should switch to the first tab
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
    await expect(tab2).not.toBeVisible();
  });

  test('tab badges show unresolved comment counts', async ({ page }) => {
    await openFixture(page, FIXTURE_1);

    await addComment(page, 'valid credentials', 'Tab badge test comment');

    const tabBar = page.locator('.h-9');
    const tab1 = tabBar.locator('button', { hasText: 'test-doc.md' }).first();
    const badge = tab1.locator('span.rounded-full');
    await expect(badge).toHaveText('1');

    await addComment(page, 'brute force attacks', 'Second tab badge comment');
    await expect(badge).toHaveText('2');

    // Resolve one — badge should drop to 1
    const card = getCard(page, 'Tab badge test comment');
    await card.hover();
    await card.getByRole('button', { name: 'Resolve' }).click({ force: true });
    await expect(badge).toHaveText('1');
  });
});

// ---------------------------------------------------------------------------
// 2. Overlapping comments
// ---------------------------------------------------------------------------

test.describe('Overlapping comments', () => {
  test('two comments on overlapping text both appear in sidebar', async ({ page }) => {
    // Pre-create a file with two overlapping comments baked in, then open it.
    // Comment 1 anchors "email and password login"
    // Comment 2 anchors "password login"
    // These overlap on "password login".
    const withOverlapping = FIXTURE_1_ORIGINAL.replace(
      'email and password login',
      '<!-- @comment{"id":"overlap-1","anchor":"email and password login","text":"Comment on full phrase","author":"User","timestamp":"2026-03-22T00:00:00.000Z","resolved":false,"status":"open","replies":[]} -->email and <!-- @comment{"id":"overlap-2","anchor":"password login","text":"Comment on password login","author":"User","timestamp":"2026-03-22T00:00:01.000Z","resolved":false,"status":"open","replies":[]} -->password login',
    );
    writeFileSync(FIXTURE_1, withOverlapping);

    await openFixture(page);

    // Both comments should be in the sidebar
    await expect(page.getByText('Comment on full phrase')).toBeVisible();
    await expect(page.getByText('Comment on password login')).toBeVisible();

    // Both should have highlights in the rendered view
    const highlights = page.locator('mark.comment-highlight');
    const count = await highlights.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('clicking overlapping highlight activates a comment in sidebar', async ({ page }) => {
    const withOverlapping = FIXTURE_1_ORIGINAL.replace(
      'email and password login',
      '<!-- @comment{"id":"ov-a","anchor":"email and password login","text":"Overlap Alpha","author":"User","timestamp":"2026-03-22T00:00:00.000Z","resolved":false,"status":"open","replies":[]} -->email and <!-- @comment{"id":"ov-b","anchor":"password login","text":"Overlap Beta","author":"User","timestamp":"2026-03-22T00:00:01.000Z","resolved":false,"status":"open","replies":[]} -->password login',
    );
    writeFileSync(FIXTURE_1, withOverlapping);

    await openFixture(page);

    // Click a highlight
    await page.locator('mark.comment-highlight').first().click();

    // One of the cards should become active
    const activeCards = page.locator('.group.rounded-lg.ring-1');
    await expect(activeCards).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Highlight ↔ sidebar sync
// ---------------------------------------------------------------------------

test.describe('Highlight and sidebar sync', () => {
  test('clicking a highlight in the viewer activates the comment in sidebar', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Sync test comment');

    // Click the heading to move focus away (won't deactivate, but that's fine)
    await page.locator('h1').first().click();

    // Click the highlight
    const highlight = page.locator('mark.comment-highlight').first();
    await expect(highlight).toBeVisible();
    await highlight.click();

    // The comment card should become active
    const card = getCard(page, 'Sync test comment');
    await expect(card).toHaveClass(/ring-1/);
  });

  test('activating a comment in sidebar scrolls to and highlights it in viewer', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'double-submit cookie pattern', 'Scroll sync comment');

    // Scroll viewer to top
    await page.evaluate(() => {
      document.querySelector('.overflow-y-auto')?.scrollTo(0, 0);
    });

    // Click the comment card in the sidebar
    const card = getCard(page, 'Scroll sync comment');
    await card.click();

    // The active highlight should be visible in the viewport
    const activeMark = page.locator('mark.comment-highlight-active');
    await expect(activeMark.first()).toBeVisible();
    await expect(activeMark.first()).toBeInViewport();
  });

  test('accepted comments do not show highlights', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Will be accepted');

    await expect(page.locator('mark.comment-highlight')).toHaveCount(1);

    // Resolve the comment
    const card = getCard(page, 'Will be accepted');
    await card.hover();
    await card.getByRole('button', { name: 'Resolve' }).click({ force: true });

    // Highlight should be gone (accepted comments are not highlighted)
    await expect(page.locator('mark.comment-highlight')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Session persistence
// ---------------------------------------------------------------------------

test.describe('Session persistence', () => {
  test('open tabs and active tab survive page reload', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await openSecondFile(page);

    // Wait for session to persist (debounce is 500ms)
    await page.waitForTimeout(1000);

    await page.reload();

    // Both tabs should still be open
    const tabBar = page.locator('.h-9');
    await expect(tabBar.locator('button', { hasText: 'test-doc.md' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(tabBar.locator('button', { hasText: 'test-doc-2.md' })).toBeVisible();

    // Active tab should be the second file
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({ timeout: 10_000 });
  });

  test('sidebar visibility persists across reload', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('h2', { hasText: 'Comments' })).toBeVisible();

    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('h2', { hasText: 'Comments' })).not.toBeVisible();

    await page.waitForTimeout(1000);
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await expect(page.locator('h2', { hasText: 'Comments' })).not.toBeVisible();
  });

  test('sidebar filter persists across reload', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Filter persist test');

    const filterBar = page.locator('.px-3.pt-3.pb-1');
    await filterBar.getByRole('button', { name: /Open/ }).click();

    await page.waitForTimeout(1000);
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    const openTab = page.locator('.px-3.pt-3.pb-1').getByRole('button', { name: /Open/ });
    await expect(openTab).toHaveClass(/bg-primary-bg-strong/);
  });

  test('view mode persists across reload', async ({ page }) => {
    await openFixture(page);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('pre', { hasText: '# Test Document' })).toBeVisible();

    await page.waitForTimeout(1000);
    await page.reload();

    await expect(page.locator('pre', { hasText: '# Test Document' })).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 5. SSE file watching
// ---------------------------------------------------------------------------

test.describe('SSE file watching', () => {
  test('external file modification triggers content reload', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();

    // Wait for SSE connection to establish and any recentWrites guard to clear.
    // The server needs time to set up the fs.watch after the SSE connection opens.
    await page.waitForTimeout(1500);

    // Modify the file externally
    const modified = FIXTURE_1_ORIGINAL.replace('## Section One', '## Modified Section');
    writeFileSync(FIXTURE_1, modified);

    // The content should update via SSE (150ms debounce + rendering time)
    await expect(page.getByRole('heading', { name: 'Modified Section' })).toBeVisible({ timeout: 15_000 });
  });

  test('external comment status change shows toast notification', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Agent will address this');

    // Wait for save to flush + recentWrites guard to clear + SSE to stabilize
    await page.waitForTimeout(1500);

    // Read the current file, change the comment status to "addressed"
    const currentContent = readFileSync(FIXTURE_1, 'utf-8');
    const addressedContent = currentContent.replace('"status":"open"', '"status":"addressed"');
    writeFileSync(FIXTURE_1, addressedContent);

    // Should show a toast about addressed comments
    await expect(page.getByText(/Agent addressed 1 comment/)).toBeVisible({ timeout: 15_000 });
  });

  test('external reply addition shows toast notification', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Waiting for reply');

    await page.waitForTimeout(1500);

    // Add a reply externally.
    // insertComment doesn't include a "replies" key, so we need to insert it.
    const currentContent = readFileSync(FIXTURE_1, 'utf-8');
    // Add replies array before the closing }} of the comment JSON
    const withReply = currentContent.replace(
      /"status":"open"(,"contextBefore":[^}]*)?}/,
      (match) => match.slice(0, -1) + ',"replies":[{"id":"ext-reply-1","text":"Done!","author":"Agent","timestamp":"2026-03-22T00:00:00.000Z"}]}',
    );
    writeFileSync(FIXTURE_1, withReply);

    await expect(page.getByText(/1 new reply added/)).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Drag-resize anchors
// ---------------------------------------------------------------------------

test.describe('Drag-resize anchors', () => {
  test('drag handles appear when a comment is active', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Drag handle test');

    const card = getCard(page, 'Drag handle test');
    await card.click();

    const handles = page.locator('[data-drag-handle]');
    await expect(handles).toHaveCount(2);
  });

  test('drag handles disappear when switching to raw view', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Handle visibility test');

    // Activate the comment
    const card = getCard(page, 'Handle visibility test');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    // Switch to raw view — highlights and handles are not rendered
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(0);
  });

  test('dragging the end handle expands the anchor', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'email and password', 'Drag expand test');

    const card = getCard(page, 'Drag expand test');
    await card.click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(2);

    const endHandle = page.locator('[data-drag-handle]').last();
    const handleBox = await endHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    // Drag the end handle to the right to expand
    await endHandle.hover();
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width + 80, handleBox!.y + handleBox!.height / 2);
    await page.mouse.up();

    await page.waitForTimeout(500);

    // The anchor in the card should now be longer
    const anchorPreview = card.locator('.font-mono').first();
    const anchorText = await anchorPreview.textContent();
    const cleanAnchor = anchorText?.replace(/["\u201C\u201D]/g, '').trim() ?? '';
    expect(cleanAnchor.length).toBeGreaterThan('email and password'.length);
  });

  test('pressing Escape during drag cancels it', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Escape drag test');

    const card = getCard(page, 'Escape drag test');
    await card.click();

    const endHandle = page.locator('[data-drag-handle]').last();
    const handleBox = await endHandle.boundingBox();

    await endHandle.hover();
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 100, handleBox!.y);

    await page.keyboard.press('Escape');

    // Anchor should remain unchanged
    const anchorPreview = card.locator('.font-mono').first();
    const anchorText = await anchorPreview.textContent();
    const cleanAnchor = anchorText?.replace(/["\u201C\u201D]/g, '').trim() ?? '';
    expect(cleanAnchor).toBe('valid credentials');
  });
});
