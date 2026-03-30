import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withMod } from './helpers/shortcuts';
import { TEST_DOC_2_BASELINE, TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = TEST_DOC_BASELINE;
const FIXTURE_2_ORIGINAL = TEST_DOC_2_BASELINE;
const OVERFLOW_FIXTURES = Array.from({ length: 6 }, (_, index) =>
  resolve(__dirname, `fixtures/overflow-tab-${index + 1}.md`),
);

function resetOverflowFixtures() {
  OVERFLOW_FIXTURES.forEach((fixture, index) => {
    writeFileSync(
      fixture,
      FIXTURE_1_ORIGINAL.replace('# Test Document', `# Overflow Tab ${index + 1}`),
    );
  });
}

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  resetOverflowFixtures();
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  resetOverflowFixtures();
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

async function openFile(page: Page, fixture: string, expectedHeading: string) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(fixture);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(page.getByRole('heading', { name: expectedHeading })).toBeVisible({
    timeout: 10_000,
  });
}

/** Open a second file via the + tab button and the file input form. */
async function openSecondFile(page: Page) {
  await openFile(page, FIXTURE_2, 'Second Test Document');
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

  test('open file shortcut handler opens the picker and loads a second tab', async ({ page }) => {
    await openFixture(page, FIXTURE_1);

    await page.evaluate((isMac) => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'o',
          bubbles: true,
          cancelable: true,
          metaKey: isMac,
          ctrlKey: !isMac,
        }),
      );
    }, process.platform === 'darwin');
    const fileInput = page.getByPlaceholder('File path or name...');
    await expect(fileInput).toBeVisible();
    await fileInput.fill(FIXTURE_2);
    await fileInput.press('Enter');

    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    await expect(page.locator('.h-9 button', { hasText: 'test-doc.md' }).first()).toBeVisible();
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

  test('closing a loading tab does not poison reopening the same file', async ({ page }) => {
    await openFixture(page, FIXTURE_1);

    let delayNextLoad = true;
    await page.route('**/api/file?path=*test-doc-2.md*', async (route) => {
      if (delayNextLoad) {
        delayNextLoad = false;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      await route.continue();
    });

    await openSecondFile(page);

    const tabBar = page.locator('.h-9');
    const loadingTab = tabBar.locator('button', { hasText: 'test-doc-2.md' });
    await expect(loadingTab).toBeVisible();
    await loadingTab.click({ button: 'middle' });
    await expect(loadingTab).not.toBeVisible();

    // Let the delayed response resolve; it should not reinsert hidden tab state.
    await page.waitForTimeout(1500);

    await openSecondFile(page);

    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(tabBar.locator('button', { hasText: 'test-doc-2.md' })).toBeVisible();
  });

  test('tab badges show comment counts', async ({ page }) => {
    await openFixture(page, FIXTURE_1);

    await addComment(page, 'valid credentials', 'Tab badge test comment');

    const tabBar = page.locator('.h-9');
    const tab1 = tabBar.locator('button', { hasText: 'test-doc.md' }).first();
    const badge = tab1.locator('span.rounded-full');
    await expect(badge).toHaveText('1');

    await addComment(page, 'brute force attacks', 'Second tab badge comment');
    await expect(badge).toHaveText('2');
  });

  test('Cmd+Shift+[ / ] cycle tabs', async ({ page }) => {
    await openFixture(page, FIXTURE_1);
    await openSecondFile(page);

    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();

    await page.keyboard.press(withMod('Shift+BracketLeft'));
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();

    await page.keyboard.press(withMod('Shift+BracketRight'));
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
  });

  test('overflow keeps open-file control visible and exposes hidden tabs via menu', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openFixture(page, FIXTURE_1);

    for (const [index, fixture] of OVERFLOW_FIXTURES.entries()) {
      await openFile(page, fixture, `Overflow Tab ${index + 1}`);
    }

    await expect(page.locator('button[title="Open file"]')).toBeVisible();
    await expect(page.locator('button[title="Scroll tabs left"]')).toBeVisible();
    await expect(page.locator('button[title="Scroll tabs right"]')).toBeVisible();

    await page.getByTestId('tab-list-button').click();
    const tabListMenu = page.getByTestId('tab-list-menu');
    await expect(tabListMenu).toBeVisible();
    await tabListMenu.locator('button', { hasText: 'test-doc.md' }).click();

    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
    await expect(page.locator('button[title="Open file"]')).toBeVisible();
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
      '<!-- @comment{"id":"overlap-1","anchor":"email and password login","text":"Comment on full phrase","author":"User","timestamp":"2026-03-22T00:00:00.000Z","replies":[]} -->email and <!-- @comment{"id":"overlap-2","anchor":"password login","text":"Comment on password login","author":"User","timestamp":"2026-03-22T00:00:01.000Z","replies":[]} -->password login',
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
      '<!-- @comment{"id":"ov-a","anchor":"email and password login","text":"Overlap Alpha","author":"User","timestamp":"2026-03-22T00:00:00.000Z","replies":[]} -->email and <!-- @comment{"id":"ov-b","anchor":"password login","text":"Overlap Beta","author":"User","timestamp":"2026-03-22T00:00:01.000Z","replies":[]} -->password login',
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

  test('activating a comment in sidebar scrolls to and highlights it in viewer', async ({
    page,
  }) => {
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
    await expect(tabBar.locator('button', { hasText: 'test-doc.md' }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(tabBar.locator('button', { hasText: 'test-doc-2.md' })).toBeVisible();

    // Active tab should be the second file
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('sidebar visibility persists across reload', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('h2', { hasText: 'Comments' })).toBeVisible();

    // Use the toolbar button instead of keyboard shortcut (unreliable in headless)
    const toggleBtn = page.locator('button[title*="Toggle comments sidebar"]');
    await toggleBtn.click();
    let cls = (await toggleBtn.getAttribute('class')) ?? '';
    expect(cls).not.toContain('bg-primary-bg');

    await page.waitForTimeout(1000);
    await page.reload();
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    // Sidebar should still be hidden after reload (toggle not active)
    cls =
      (await page.locator('button[title*="Toggle comments sidebar"]').getAttribute('class')) ?? '';
    expect(cls).not.toContain('bg-primary-bg');
  });

  test('view mode persists across reload', async ({ page }) => {
    await openFixture(page);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table', { hasText: '# Test Document' })).toBeVisible();

    await page.waitForTimeout(1000);
    await page.reload();

    await expect(page.locator('.raw-view-table', { hasText: '# Test Document' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('URL file parameter wins over restored tabs', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      ([fixture1, fixture2]) => {
        localStorage.setItem(
          'md-redline-session',
          JSON.stringify({
            openTabs: [fixture1, fixture2],
            activeFilePath: fixture2,
          }),
        );
      },
      [FIXTURE_1, FIXTURE_2],
    );

    await page.goto(`/?file=${FIXTURE_1}`);

    const tabBar = page.locator('.h-9');
    await expect(tabBar.locator('button', { hasText: 'test-doc.md' }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(tabBar.locator('button', { hasText: 'test-doc-2.md' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. SSE file watching
// ---------------------------------------------------------------------------

test.describe('SSE file watching', () => {
  test('adding a comment does not trigger the Changed badge', async ({ page }) => {
    await openFixture(page);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    await addComment(page, 'valid credentials', 'Self-write test');

    // Wait long enough for any false SSE notification to arrive (150ms debounce + margin)
    await page.waitForTimeout(1000);

    // The "Changed" badge should NOT appear for our own save
    await expect(page.getByText('Changed')).not.toBeVisible();
  });

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
    await expect(page.getByRole('heading', { name: 'Modified Section' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('external reply addition shows toast notification', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Waiting for reply');

    await page.waitForTimeout(1500);

    // Add a reply externally by injecting a replies array into the comment JSON.
    const currentContent = readFileSync(FIXTURE_1, 'utf-8');
    // Find the comment marker and inject replies before the closing }
    const withReply = currentContent.replace(
      /(@comment\{[^}]*"text":"Waiting for reply"[^}]*)\}/,
      '$1,"replies":[{"id":"ext-reply-1","text":"Done!","author":"Agent","timestamp":"2026-03-22T00:00:00.000Z"}]}',
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
    await page.mouse.move(
      handleBox!.x + handleBox!.width + 80,
      handleBox!.y + handleBox!.height / 2,
    );
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
