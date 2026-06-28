import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

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

test.describe('Selection pill', () => {
  test('one-tap template prefills the form and the comment lands in the file', async ({
    page,
  }) => {
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
    await expect(page.getByText('Quick templates:')).not.toBeVisible();

    await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment', exact: true }).click();

    await expect(page.locator('mark.comment-highlight')).toBeVisible();
    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'))
      .toContain('@comment{');
  });

  test('Comment opens the form without the grid; overflow opens it with the grid', async ({
    page,
  }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');

    const pill = page.locator('[data-comment-form]');
    await pill.getByRole('button', { name: /Comment/ }).first().click();
    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible();
    await expect(page.getByText('Quick templates:')).not.toBeVisible();

    // The footer toggle still summons the grid on demand
    await page.locator('[data-comment-form] button[title="Quick templates"]').click();
    await expect(page.getByText('Quick templates:')).toBeVisible();

    // Dismiss, reselect, take the overflow path
    await page.keyboard.press('Escape');
    await selectText(page, 'validates all inputs');
    await pill.getByRole('button', { name: 'More templates' }).click();
    await expect(page.getByText('Quick templates:')).toBeVisible();
    await expect(page.getByPlaceholder('Add your comment...')).toHaveValue('');
  });
});
