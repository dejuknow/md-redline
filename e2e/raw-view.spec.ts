import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
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

test.afterAll(async () => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

async function switchToRaw(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
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

// ---------------------------------------------------------------------------
// 1. Line numbers
// ---------------------------------------------------------------------------

test.describe('Line numbers', () => {
  test('line numbers are shown in raw view', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    const lineNumbers = page.locator('.raw-line-number');
    // test-doc.md has 18 lines
    await expect(lineNumbers).toHaveCount(18);
    await expect(lineNumbers.first()).toHaveText('1');
    await expect(lineNumbers.last()).toHaveText('18');
  });

  test('line numbers match actual file lines', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    // Verify some specific line numbers
    const lines = page.locator('.raw-line');
    // Line 1 should contain "# Test Document"
    await expect(lines.nth(0).locator('.raw-line-content')).toContainText('# Test Document');
    await expect(lines.nth(0).locator('.raw-line-number')).toHaveText('1');
  });
});

// ---------------------------------------------------------------------------
// 2. Syntax highlighting
// ---------------------------------------------------------------------------

test.describe('Syntax highlighting', () => {
  test('headings are highlighted', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    const headings = page.locator('.raw-heading');
    // "# Test Document", "## Overview", "## Section One", "## Section Two", "## Section Three"
    await expect(headings).toHaveCount(5);
  });

  test('bold text is highlighted', async ({ page }) => {
    await openFixture(page);
    // Add a comment first to get some bold text in view — actually the fixture
    // doesn't have bold. Let's just verify the class exists when viewing content
    // with bold syntax.
    // Write a fixture with bold
    writeFileSync(FIXTURE, '# Title\n\n**Bold text** and *italic*\n');
    await page.goto(`/?file=${FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'Title' })).toBeVisible({ timeout: 10_000 });
    await switchToRaw(page);

    await expect(page.locator('.raw-bold')).toHaveCount(1);
    await expect(page.locator('.raw-italic')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Comment marker highlighting
// ---------------------------------------------------------------------------

test.describe('Comment markers in raw view', () => {
  test('comment markers are visually highlighted', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Test comment');

    await switchToRaw(page);

    // The comment marker should be highlighted
    const markers = page.locator('.raw-comment-marker');
    await expect(markers).toHaveCount(1);
    await expect(markers.first()).toContainText('@comment');
  });

  test('active comment marker gets active class when sidebar comment clicked', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Marker active test');

    await switchToRaw(page);

    // Click the comment in sidebar
    const card = page.locator('.group.rounded-lg', { hasText: 'Marker active test' });
    await card.click();

    // The marker should have the active class
    await expect(page.locator('.raw-comment-marker-active')).toHaveCount(1);
  });

  test('comment marker has data-comment-id attribute', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'ID test');

    await switchToRaw(page);

    const marker = page.locator('.raw-comment-marker[data-comment-id]');
    await expect(marker).toHaveCount(1);
    // The ID should be a UUID-like string
    const id = await marker.getAttribute('data-comment-id');
    expect(id).toBeTruthy();
    expect(id!.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Copy button — clean markdown only (no markers), available in both views
// ---------------------------------------------------------------------------

test.describe('Copy button', () => {
  test('copy button is visible in raw view', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    const copyBtn = page.getByTestId('copy-button');
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toHaveAttribute('title', 'Copy document (comment markers stripped)');
  });

  test('copy button is also visible in rendered view', async ({ page }) => {
    await openFixture(page);

    const copyBtn = page.getByTestId('copy-button');
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toHaveAttribute('title', 'Copy document (comment markers stripped)');
  });

  test('copy button shows "Copied!" feedback after click', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-write']);

    const copyBtn = page.getByTestId('copy-button');
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute('title', 'Copied!');

    // Feedback should disappear after ~2 seconds
    await expect(copyBtn).toHaveAttribute(
      'title',
      'Copy document (comment markers stripped)',
      { timeout: 5000 },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Sidebar-to-raw-view linking
// ---------------------------------------------------------------------------

test.describe('Sidebar to raw view linking', () => {
  test('clicking sidebar comment scrolls raw view to the marker', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Scroll target');

    await switchToRaw(page);

    // Click the comment in sidebar
    const card = page.locator('.group.rounded-lg', { hasText: 'Scroll target' });
    await card.click();

    // The marker should be visible (scrolled into view)
    const marker = page.locator('.raw-comment-marker');
    await expect(marker).toBeVisible();

    // Flash animation class should be applied
    await expect(page.locator('.raw-comment-marker-flash')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Copy strips comment markers by default (no "with markers" path)
// ---------------------------------------------------------------------------

test.describe('Copy strips comment markers', () => {
  test('clipboard content has no comment markers', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Strip me');

    await switchToRaw(page);

    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);

    await page.getByTestId('copy-button').click();
    await expect(page.getByTestId('copy-button')).toHaveAttribute('title', 'Copied!');

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).not.toContain('@comment');
    expect(clipboardText).toContain('valid credentials');
    expect(clipboardText).toContain('# Test Document');
  });
});

// ---------------------------------------------------------------------------
// 7. Toolbar stays pinned when raw view scrolls
// ---------------------------------------------------------------------------
//
// Regression: in v0.1.2 the raw view container collapsed from a flex-column
// (toolbar + inner scroll wrapper) into a single overflow-y-auto div, causing
// the toolbar to scroll along with the content. Pinning is enforced purely by
// the layout: .raw-view is flex-col h-full, the toolbar is a fixed-height
// sibling, and an inner div takes flex-1 with overflow-y-auto.

test.describe('Toolbar pinning', () => {
  test('toolbar stays in place when content scrolls', async ({ page }) => {
    // Small viewport guarantees overflow even for the short fixture, since
    // .raw-view's inner wrapper has pb-[50vh] padding.
    await page.setViewportSize({ width: 1024, height: 500 });

    await openFixture(page);
    await switchToRaw(page);

    const toolbar = page.locator('.raw-toolbar');
    await expect(toolbar).toBeVisible();

    const initialBox = await toolbar.boundingBox();
    expect(initialBox).not.toBeNull();

    // Structural check: the scroll container must be an INNER element of
    // .raw-view, not .raw-view itself. The regression in v0.1.2 collapsed
    // these into a single overflow-y-auto div, which caused the toolbar to
    // scroll along with the content.
    //
    // We also scroll the inner container and confirm the toolbar's bounding
    // box doesn't move. Use scrollTo({ behavior: 'instant' }) because
    // .overflow-y-auto has scroll-behavior: smooth set globally in index.css,
    // which makes a plain scrollTop assignment animate (and read back as 0
    // before the animation starts).
    const scrollResult = await page.evaluate(() => {
      const view = document.querySelector('.raw-view') as HTMLElement | null;
      if (!view) return { ok: false as const, reason: 'no-view' };
      if (view.scrollHeight > view.clientHeight + 1) {
        return { ok: false as const, reason: 'view-is-scroller' };
      }
      const inner = view.querySelector('.overflow-y-auto') as HTMLElement | null;
      if (!inner) return { ok: false as const, reason: 'no-inner-scroller' };
      if (inner === view) return { ok: false as const, reason: 'inner-is-view' };
      if (inner.scrollHeight <= inner.clientHeight + 1) {
        return { ok: false as const, reason: 'inner-not-scrollable' };
      }
      inner.scrollTo({ top: 250, behavior: 'instant' as ScrollBehavior });
      return { ok: true as const, scrollTop: inner.scrollTop };
    });

    expect(scrollResult.ok, `scroll setup failed: ${JSON.stringify(scrollResult)}`).toBe(true);
    if (scrollResult.ok) {
      expect(scrollResult.scrollTop).toBeGreaterThan(0);
    }

    // Toolbar position must be unchanged after scrolling.
    const afterBox = await toolbar.boundingBox();
    expect(afterBox).not.toBeNull();
    expect(afterBox!.y).toBeCloseTo(initialBox!.y, 0);
  });
});
