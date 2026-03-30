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
// 4. Copy clean button
// ---------------------------------------------------------------------------

test.describe('Copy clean button', () => {
  test('copy clean button is visible in raw view', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    await expect(page.locator('.raw-copy-clean-btn')).toBeVisible();
    await expect(page.locator('.raw-copy-clean-btn')).toContainText('Copy clean');
  });

  test('copy clean button shows "Copied" feedback after click', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-write']);

    await page.locator('.raw-copy-clean-btn').click();
    await expect(page.locator('.raw-copy-clean-btn')).toContainText('Copied');

    // Feedback should disappear after ~2 seconds
    await expect(page.locator('.raw-copy-clean-btn')).toContainText('Copy clean', {
      timeout: 5000,
    });
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
// 6. Copy clean button does not include markers
// ---------------------------------------------------------------------------

test.describe('Copy clean strips markers', () => {
  test('clipboard content has no comment markers', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Strip me');

    await switchToRaw(page);

    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
    await page.locator('.raw-copy-clean-btn').click();
    await expect(page.locator('.raw-copy-clean-btn')).toContainText('Copied');

    // Read clipboard
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).not.toContain('@comment');
    expect(clipboardText).toContain('valid credentials');
    expect(clipboardText).toContain('# Test Document');
  });
});
