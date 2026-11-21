import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

// The browser's own selection around the viewer's painted one. This runs in
// WebKit as well as Chromium (see playwright.config.ts): the bug only ever
// showed in WebKit, whose selection behaves differently from Chromium's.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose p').first().waitFor({ timeout: 10_000 });
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

/** The viewport rect of the first occurrence of `text` in the rendered prose. */
async function textRect(page: Page, text: string) {
  return page.evaluate((target) => {
    const walker = document.createTreeWalker(
      document.querySelector('.prose')!,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.data.indexOf(target);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + target.length);
        return range.getBoundingClientRect().toJSON() as DOMRect;
      }
    }
    throw new Error(`"${target}" not found`);
  }, text);
}

test('a committed selection leaves no native selection painting around it (#228)', async ({
  page,
}) => {
  // Drag with the real mouse across two paragraphs, as a reader would.
  const start = await textRect(page, 'valid credentials');
  const end = await textRect(page, 'brute force');
  await page.mouse.move(start.left + 1, start.top + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.right - 1, end.top + end.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
  // The viewer paints the selection itself. WebKit used to keep a corrupt
  // native range after that repaint, which painted and copied whole blocks.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
});
