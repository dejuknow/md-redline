import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';
import { addComment } from './helpers/comments';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `selection-pill-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

// Same selection helper as commenting.spec.ts: select text inside the prose
// container and fire mouseup so useSelection picks it up.
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
        // Keep the anchor on-screen so the pill isn't hidden by its
        // anchorOffscreen guard (see helpers/comments.ts selectText).
        node.parentElement?.scrollIntoView({ block: 'nearest' });
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

// Selects text that lives outside the prose column, which is what the comment
// sidebar is. Mirrors selectText above except for where it looks.
async function selectOutsideProse(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const prose = document.querySelector('[data-prose-column]');
    // Fail loudly rather than silently widening to the whole page. Without the
    // marker there is nothing to exclude, so this helper would search the
    // document too and quietly stop testing what its name says it tests.
    if (!prose) throw new Error('[data-prose-column] is missing: selection is no longer scoped');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.parentElement && prose.contains(node.parentElement)) continue;
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
    throw new Error(`Text "${targetText}" not found outside the prose column`);
  }, text);
}

test.describe('Selection pill', () => {
  test('one-tap template prefills the form and the comment lands in the file', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    const pill = page.locator('[data-comment-form]');
    await expect(pill.getByRole('button', { name: /Comment/ })).toBeVisible({ timeout: 5000 });
    await expect(pill.getByRole('button', { name: 'Rewrite this' })).toBeVisible();
    await expect(pill.getByRole('button', { name: 'More templates' })).toBeVisible();

    await pill.getByRole('button', { name: 'Rewrite this' }).click();
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(/Rewrite/);
    // Grid stays hidden when a pill template was tapped
    await expect(
      page.locator('[data-comment-form]').getByText('Quick templates:'),
    ).not.toBeVisible();

    await pill.getByRole('button', { name: 'Comment', exact: true }).click();

    await expect(page.locator('mark.comment-highlight')).toBeVisible();
    await expect.poll(() => readFileSync(fixturePath, 'utf-8')).toContain('@comment{');
  });

  test('Comment opens the form without the grid; overflow lists the remaining templates in place', async ({
    page,
  }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    const pill = page.locator('[data-comment-form]');
    await pill.getByRole('button', { name: /Comment/ }).click();
    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible();
    await expect(
      page.locator('[data-comment-form]').getByText('Quick templates:'),
    ).not.toBeVisible();

    // The footer toggle still summons the grid on demand
    await page.locator('[data-comment-form] button[title="Quick templates"]').click();
    await expect(page.locator('[data-comment-form]').getByText('Quick templates:')).toBeVisible();

    // Dismiss, reselect, take the overflow path: the kebab expands a menu of
    // the remaining templates instead of jumping to the form.
    await page.keyboard.press('Escape');
    await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible();
    await selectText(page, 'validates all inputs');
    await pill.getByRole('button', { name: 'More templates' }).click();
    const menu = page.locator('[data-pill-template-menu]');
    await expect(menu).toBeVisible();
    await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible();

    // Picking one prefills the form with that template, like the inline
    // one-tap buttons.
    const firstMenuItem = menu.locator('button').first();
    const label = (await firstMenuItem.textContent())!.trim();
    await firstMenuItem.click();
    await expect(menu).not.toBeVisible();
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeVisible();
    await expect(textarea).not.toHaveValue('');
    expect(label.length).toBeGreaterThan(0);
  });

  test('selecting a comment card in the sidebar does not open a composer', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Is this per tenant?');

    // The card is chrome, not document. Before selection was scoped to the
    // prose column it lived inside the element selections resolved against,
    // so dragging across a comment offered to anchor a new comment to the
    // old one's text.
    await selectOutsideProse(page, 'Is this per tenant?');

    await expect(page.locator('[data-comment-form]')).toHaveCount(0);
  });
});

test.describe('triple-click with quick comment on', () => {
  // Quick comment persists to the prefs file that every later spec boots into.
  test.afterAll(() => clearPersistedPreferences());

  test('anchors the composer to the line a triple-click selects', async ({ page }) => {
    // The second press selects a word, and quick comment opens and locks the
    // composer on it. The third press then widened only the browser's
    // highlight, so the composer kept offering the word.
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible({
      timeout: 10_000,
    });

    const point = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('.prose h2')].find((h) =>
        h.textContent?.includes('Section One'),
      );
      if (!heading) throw new Error('"Section One" heading not found');
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.indexOf('Section') ?? -1;
        if (idx < 0) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'Section'.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error('"Section" not found in the heading');
    });
    // Real presses rather than a synthetic mouseup: the bug is in how the three
    // presses of one gesture arrive.
    await page.mouse.click(point.x, point.y, { clickCount: 3 });

    await expect(page.locator('[data-comment-form]')).toContainText('“Section One”', {
      timeout: 5000,
    });
  });
});
