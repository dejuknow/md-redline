import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EMPHASIS_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/emphasis-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, EMPHASIS_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, EMPHASIS_DOC_BASELINE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Emphasis Fixture' })).toBeVisible({
    timeout: 10_000,
  });
}

/** Select a whole block by CSS selector, the way a drag over it would. */
async function selectBlock(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(`.prose ${sel}`);
    if (!el) throw new Error(`block not found: ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, selector);
  await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
}

async function copyAsMarkdown(page: Page) {
  // Dispatched rather than clicked: with a composer open the pill can cover its
  // own anchor, and this test is about what lands on the clipboard.
  await page
    .locator('mark.selection-highlight')
    .first()
    .dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  await page
    .locator('.context-menu-enter')
    .getByText('Copy as Markdown', { exact: true })
    .click({ timeout: 5000 });
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('Copy as Markdown', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('a fenced code block comes back with its fences', async ({ page }) => {
    await openFixture(page);
    await selectBlock(page, 'pre');
    expect(await copyAsMarkdown(page)).toBe(
      "```js\nconst codeBlock = 'fenced code renders at code ink';\n```",
    );
  });

  test('a list comes back with its bullets', async ({ page }) => {
    await openFixture(page);
    await selectBlock(page, 'ul');
    expect(await copyAsMarkdown(page)).toBe(
      '- List item with **bold inside it**\n- Second item for the ordered sibling below',
    );
  });

  test('a blockquote comes back with its marker', async ({ page }) => {
    await openFixture(page);
    await selectBlock(page, 'blockquote');
    expect(await copyAsMarkdown(page)).toBe('> Quoted passage with **bold inside the quote**.');
  });

  test('a table comes back as a table', async ({ page }) => {
    await openFixture(page);
    await selectBlock(page, 'table');
    expect(await copyAsMarkdown(page)).toContain('| Column | Header with **bold** |');
  });
});
