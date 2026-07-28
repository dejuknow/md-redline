import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
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
    `touch-selection-${process.pid}-${testInfo.retry}-${Date.now()}`,
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

// Create a DOM selection the way a touch gesture leaves it: a pointerdown
// with pointerType 'touch' followed by a programmatic range selection and NO
// mouseup — native touch selection never fires one. The browser fires
// selectionchange itself when the range is added.
async function selectTextViaPointer(page: Page, text: string, pointerType: string) {
  await page.evaluate(
    ({ targetText, pt }) => {
      const prose = document.querySelector('.prose') || document.body;
      prose.dispatchEvent(new PointerEvent('pointerdown', { pointerType: pt, bubbles: true }));
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
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
          node.parentElement?.scrollIntoView({ block: 'nearest' });
          return;
        }
      }
      throw new Error(`Text "${targetText}" not found in rendered markdown`);
    },
    { targetText: text, pt: pointerType },
  );
}

test.describe('Touch selection', () => {
  test('touch selection shows the commit button instead of auto-opening the form', async ({
    page,
  }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');

    const commit = page.getByTestId('pending-selection-commit');
    await expect(commit).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-comment-form]')).toHaveCount(0);
  });

  test('adjusting the selection keeps the form closed and the button up', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    const commit = page.getByTestId('pending-selection-commit');
    await expect(commit).toBeVisible({ timeout: 5000 });

    // Simulate handle adjustment: re-select a wider region, still no mouseup.
    await selectTextViaPointer(page, 'valid credentials to access', 'touch');
    await expect(commit).toBeVisible();
    await expect(page.locator('[data-comment-form]')).toHaveCount(0);
  });

  test('tapping the commit button opens the comment flow on the selection', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    const commit = page.getByTestId('pending-selection-commit');
    await expect(commit).toBeVisible({ timeout: 5000 });

    await commit.click();
    await expect(page.locator('[data-comment-form]')).toBeVisible({ timeout: 5000 });
    await expect(commit).toHaveCount(0);
  });

  test('pen selections use the pending flow too', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'pen');
    await expect(page.getByTestId('pending-selection-commit')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-comment-form]')).toHaveCount(0);
  });

  test('collapsing the selection hides the commit button', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    const commit = page.getByTestId('pending-selection-commit');
    await expect(commit).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }),
      );
      window.getSelection()?.removeAllRanges();
    });
    await expect(commit).toHaveCount(0, { timeout: 5000 });
  });

  test('mouse selection still opens the form immediately with no commit button', async ({
    page,
  }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'mouse');
    // Mouse flow: fire the mouseup that ends a drag-select.
    await page.evaluate(() => {
      const sel = window.getSelection()!;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      sel.anchorNode?.parentElement?.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    await expect(page.locator('[data-comment-form]')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('pending-selection-commit')).toHaveCount(0);
  });
});
