import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = readFileSync(FIXTURE, 'utf-8');

// Restore the fixture file before each test so tests are independent
test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  // Clear localStorage to avoid session state leaking between tests
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(async () => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

/** Open the test fixture file and wait for it to render */
async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
}

/**
 * Select text in the rendered markdown viewer by creating a real DOM selection.
 */
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

/** Select text, fill the form, and submit — returns the comment text for assertions. */
async function addComment(page: Page, anchorText: string, commentText: string) {
  await selectText(page, anchorText);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

/**
 * Get the comment card container that holds a comment with the given text.
 * Uses the data structure: card > div.px-3.py-2 > p (comment text)
 */
function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

/**
 * Hover on a card and click an action button.
 * Action buttons have opacity-0 until hover, so we must force-click.
 */
async function clickCardAction(page: Page, commentText: string, actionName: string) {
  const card = getCard(page, commentText);
  await card.hover();
  // Force click since the button may be opacity-0 until CSS hover fully applies
  await card.getByRole('button', { name: actionName, exact: true }).click({ force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('File opening', () => {
  test('opens a file via URL query param', async ({ page }) => {
    await openFixture(page);
    // Tab shows filename
    await expect(page.locator('.h-9 button', { hasText: 'test-doc.md' }).first()).toBeVisible();
    // Rendered content visible
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();
  });

  test('opens a file via the file opener dialog', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(FIXTURE);
    await page.getByPlaceholder('File path or name...').press('Enter');
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Adding comments', () => {
  test('select text and add a comment via the floating form', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'This needs more detail about what valid means.');
  });

  test('comment is persisted to the markdown file', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Clarify the rate limit window.');

    // Wait for the save to flush
    await page.waitForTimeout(500);
    const content = readFileSync(FIXTURE, 'utf-8');
    expect(content).toContain('@comment');
    expect(content).toContain('Clarify the rate limit window.');
  });

  test('apply quick template with keyboard shortcut', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'Session tokens');

    await expect(
      page.locator('[data-comment-form] button', { hasText: 'Comment' }),
    ).toBeVisible({ timeout: 5000 });

    // Cmd+1 applies the first template ("Rewrite this section")
    await page.keyboard.press('Meta+1');

    await expect(
      page.getByText('Rewrite this section — it needs to be clearer.'),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Comment lifecycle', () => {
  test('delete a comment', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'hashed with bcrypt', 'Mention cost factor');

    await clickCardAction(page, 'Mention cost factor', 'Delete');

    await expect(page.getByText('Mention cost factor')).not.toBeVisible();
  });
});

test.describe('Comment editing and replies', () => {
  test('edit a comment', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'tracked per IP address', 'Original edit text');

    await clickCardAction(page, 'Original edit text', 'Edit');

    // The edit textarea is inside the sidebar; locate it directly
    const editArea = page.locator('.group.rounded-lg textarea').first();
    await expect(editArea).toBeVisible();
    // fill() clears then types — avoids re-render issues from a separate clear()
    await editArea.fill('Updated comment text');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Updated comment text')).toBeVisible();
    await expect(page.getByText('Original edit text')).not.toBeVisible();
  });

  test('add a reply to a comment', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'double-submit cookie pattern', 'Is this still best practice?');

    const card = getCard(page, 'Is this still best practice?');
    // Click the "Reply" text button at the bottom of the card
    await card.getByRole('button', { name: 'Reply' }).click();

    const replyArea = card.getByPlaceholder('Write a reply...');
    await expect(replyArea).toBeVisible();
    await replyArea.fill('Yes, still recommended per OWASP.');

    // Click the Reply submit button (the one inside the reply form, not the trigger)
    await card.locator('textarea + div').getByRole('button', { name: 'Reply' }).click();

    await expect(page.getByText('Yes, still recommended per OWASP.')).toBeVisible();
  });
});

test.describe('Sidebar filtering', () => {
  test('search filters comments by text', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'Fix authentication flow');
    await addComment(page, 'brute force attacks', 'Improve rate limiting');

    await page.getByPlaceholder('Search comments...').fill('rate');

    await expect(page.getByText('Improve rate limiting')).toBeVisible();
    await expect(getCard(page, 'Fix authentication flow')).not.toBeVisible();
  });
});

test.describe('View modes', () => {
  test('toggle raw markdown view', async ({ page }) => {
    await openFixture(page);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table', { hasText: '# Test Document' })).toBeVisible();

    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('h1', { hasText: 'Test Document' })).toBeVisible();
  });
});

test.describe('Keyboard navigation', () => {
  test('N and P keys cycle through comments', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'valid credentials', 'First comment');
    await addComment(page, 'brute force attacks', 'Second comment');

    // Clear selection
    await page.keyboard.press('Escape');

    // Press N to jump to first comment
    await page.keyboard.press('n');
    await expect(getCard(page, 'First comment')).toHaveClass(/ring-1/);

    // Press N again to jump to second
    await page.keyboard.press('n');
    await expect(getCard(page, 'Second comment')).toHaveClass(/ring-1/);

    // Press P to go back to first
    await page.keyboard.press('p');
    await expect(getCard(page, 'First comment')).toHaveClass(/ring-1/);
  });
});

test.describe('Comment form click-outside dismiss', () => {
  test('clicking outside dismisses expanded form when text is empty', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    // Expand the comment form
    const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
    await commentBtn.click();

    // Form should be expanded (textarea visible)
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible();

    // Click outside the form on the sidebar heading (not prose, not form)
    await page.locator('h2', { hasText: 'Comments' }).click({ force: true });

    // Form should be dismissed
    await expect(textarea).not.toBeVisible();
  });

  test('clicking in prose area dismisses expanded form when text is empty', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
    await commentBtn.click();

    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible();

    // Click in the prose/markdown viewer area (outside the form)
    await page.locator('.prose h2').first().click({ force: true });

    // Form should be dismissed — this is the key regression test
    await expect(textarea).not.toBeVisible({ timeout: 3000 });
  });

  test('clicking outside does NOT dismiss when form has text', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
    await commentBtn.click();

    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible();
    await textarea.fill('Some draft text');

    // Click outside the form on the sidebar heading
    await page.locator('h2', { hasText: 'Comments' }).click({ force: true });

    // Form should still be visible because it has text
    await expect(textarea).toBeVisible();
  });
});

test.describe('Sidebar toggle', () => {
  test('sidebar toggle button hides and shows sidebar', async ({ page }) => {
    await openFixture(page);

    const toggleBtn = page.locator('button[title*="Toggle comments sidebar"]');

    // Sidebar is open: toggle button has active state
    let cls = await toggleBtn.getAttribute('class') ?? '';
    expect(cls).toContain('bg-primary-bg');

    // Toggle off
    await toggleBtn.click();
    cls = await toggleBtn.getAttribute('class') ?? '';
    expect(cls).not.toContain('bg-primary-bg');

    // Toggle on
    await toggleBtn.click();
    cls = await toggleBtn.getAttribute('class') ?? '';
    expect(cls).toContain('bg-primary-bg');
  });
});
