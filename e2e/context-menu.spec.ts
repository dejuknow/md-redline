import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MOD_LABEL } from './helpers/shortcuts';

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

async function openSecondFile(page: Page) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(FIXTURE_2);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Context menu tests
// ---------------------------------------------------------------------------

test.describe('Context menu on comment highlight', () => {
  test('right-clicking a highlight shows context menu with comment actions', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Ctx menu test');

    // Right-click on the highlight mark
    const highlight = page.locator('mark.comment-highlight').first();
    await highlight.click({ button: 'right' });

    // Context menu should appear with Edit and Delete actions
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Edit')).toBeVisible();
    await expect(menu.getByText('Delete')).toBeVisible();
  });

  test('clicking Delete in context menu removes the comment', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Delete via ctx');

    const highlight = page.locator('mark.comment-highlight').first();
    await highlight.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await menu.getByText('Delete').click();

    // Comment should be removed
    await expect(page.getByText('Delete via ctx')).not.toBeVisible();
  });
});

test.describe('Context menu on tab', () => {
  test('right-clicking a tab shows tab context menu', async ({ page }) => {
    await openFixture(page);

    // Close the explorer so tab area is fully unobscured
    const explorerBtn = page.locator(`button[title="Toggle file explorer (${MOD_LABEL}+B)"]`);
    const cls = await explorerBtn.getAttribute('class') ?? '';
    if (cls.includes('bg-primary-bg')) await explorerBtn.click();
    await page.waitForTimeout(300);

    const tab = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await expect(tab).toBeVisible();
    await tab.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Close', { exact: true }).first()).toBeVisible();
    await expect(menu.getByText('Copy Path')).toBeVisible();
    await expect(menu.getByText('Copy File Name')).toBeVisible();
  });

  test('Close Others closes all except the right-clicked tab', async ({ page }) => {
    await openFixture(page);
    await openSecondFile(page);

    const explorerBtn = page.locator(`button[title="Toggle file explorer (${MOD_LABEL}+B)"]`);
    const cls = await explorerBtn.getAttribute('class') ?? '';
    if (cls.includes('bg-primary-bg')) await explorerBtn.click();
    await page.waitForTimeout(300);

    const tab1 = page.locator('.h-9 button', { hasText: 'test-doc.md' }).first();
    await tab1.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Close Others').click();

    await expect(page.locator('.h-9 button', { hasText: 'test-doc-2.md' })).not.toBeVisible();
    await expect(page.locator('.h-9 button', { hasText: 'test-doc.md' }).first()).toBeVisible();
  });
});

test.describe('Context menu on sidebar comment', () => {
  test('right-clicking a comment card shows sidebar context menu', async ({ page }) => {
    await openFixture(page);

    // Close the explorer to give sidebar more room
    await page.locator(`button[title="Toggle file explorer (${MOD_LABEL}+B)"]`).click();
    await page.waitForTimeout(300);

    await addComment(page, 'valid credentials', 'Sidebar ctx test');

    // Use coordinates-based right-click for reliability
    const card = getCard(page, 'Sidebar ctx test');
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Delete')).toBeVisible();
    await expect(menu.getByText('Copy Anchor Text')).toBeVisible();
    await expect(menu.getByText('Copy Comment Text')).toBeVisible();
    await expect(menu.getByText('Scroll to Highlight')).toBeVisible();
  });
});
