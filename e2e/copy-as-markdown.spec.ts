import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EMPHASIS_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { withMod } from './helpers/shortcuts';

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

  // A touch or pen selection stays pending and is never painted, so the copy
  // has no marks to read. It used to offer the item and then copy nothing
  // (#101). The native range is still live, and that is what it copies now.
  for (const pointerType of ['touch', 'pen']) {
    test(`a ${pointerType} selection copies through the menu too`, async ({ page }) => {
      await openFixture(page);
      // The list test above copies this same text, and the clipboard can
      // outlive a test, so start from empty or a no-op copy would pass.
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page.evaluate((pt) => {
        const el = document.querySelector('.prose ul');
        if (!el) throw new Error('block not found: ul');
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: pt, bubbles: true }));
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }, pointerType);
      await expect(page.getByTestId('pending-selection-commit')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('mark.selection-highlight')).toHaveCount(0);

      await page
        .locator('.prose ul li')
        .first()
        .dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      await page
        .locator('.context-menu-enter')
        .getByText('Copy as Markdown', { exact: true })
        .click({ timeout: 5000 });

      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe('- List item with **bold inside it**\n- Second item for the ordered sibling below');
    });
  }
});

// The palette's "Copy selection as markdown" (#163). It used to be offered for a
// mouse selection only, since it read the painted marks, and a touch or pen
// selection stays pending and is never painted. Opening the palette focuses
// its input, which takes the browser's live range with it, so the markdown is
// resolved when the palette opens rather than when the command runs.
test.describe('Copy selection as markdown from the palette', () => {
  const LIST_MARKDOWN =
    '- List item with **bold inside it**\n- Second item for the ordered sibling below';

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  async function copyFromPalette(page: Page) {
    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('copy selection');
    await page
      .locator('button[data-selected]', { hasText: 'Copy selection as markdown' })
      .click({ timeout: 5000 });
  }

  test('copies a mouse selection', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await selectBlock(page, 'ul');

    await copyFromPalette(page);

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(LIST_MARKDOWN);
  });

  for (const pointerType of ['touch', 'pen']) {
    test(`copies a ${pointerType} selection, which is never painted (#163)`, async ({ page }) => {
      await openFixture(page);
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page.evaluate((pt) => {
        const el = document.querySelector('.prose ul');
        if (!el) throw new Error('block not found: ul');
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: pt, bubbles: true }));
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }, pointerType);
      await expect(page.getByTestId('pending-selection-commit')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('mark.selection-highlight')).toHaveCount(0);

      await copyFromPalette(page);

      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(LIST_MARKDOWN);
    });
  }

  test('is not offered with nothing selected', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('copy selection');
    await expect(
      page.locator('button[data-selected]', { hasText: 'Copy selection as markdown' }),
    ).toHaveCount(0);
  });
});

// The tests above click the item with a mouse. On a tablet it is a real tap,
// which can move or clear the native selection before the click lands; the
// menu captures the range when it opens so the copy does not depend on it.
test.describe('Copy as Markdown (real touch events)', () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  async function tap(page: Page, locator: ReturnType<Page['locator']>) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('element has no bounding box');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  }

  test('a real tap on the item copies a touch selection', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    // A real tap first, so the pointer type comes from a genuine touch.
    await tap(page, page.locator('.prose ul li').first());
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.prose ul')!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.getByTestId('pending-selection-commit')).toBeVisible({ timeout: 5000 });

    // A long-press opens the menu on a tablet; Playwright has no long-press,
    // so the contextmenu it ends in is dispatched directly.
    await page
      .locator('.prose ul li')
      .first()
      .dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    await tap(
      page,
      page.locator('.context-menu-enter').getByText('Copy as Markdown', { exact: true }),
    );

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('- List item with **bold inside it**\n- Second item for the ordered sibling below');
  });
});
