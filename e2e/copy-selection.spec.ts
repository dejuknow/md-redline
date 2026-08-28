import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FORMATTED_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

// The app's document-level `copy` listener (App.tsx handleCopy) writes both
// clipboard flavors on setData, so a listener registered after it fires can
// read back exactly what it wrote. Declared globally so TS knows about the
// bag the page-side listener stashes results in; see armCopyListener below.
declare global {
  interface Window {
    __copied: { plain: string; html: string } | null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `copy-selection-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'formatted-doc.md');
  writeFileSync(fixturePath, FORMATTED_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async ({ page }) => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  // Quick comment persists to the shared e2e prefs file, and several specs
  // (review-session, update-notice, the agent-* suites) never reset app state
  // before running. Leaving it on would silently put them in a mode where any
  // selection auto-focuses the composer.
  await page.request.put('/api/preferences', { data: { settings: { quickComment: false } } });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

/**
 * Registers a `copy` listener after the app's own (App.tsx handleCopy) has
 * had a chance to register. document.addEventListener fires listeners in
 * registration order, so ours runs second and can read back whatever the app
 * called clipboardData.setData with. We don't read the OS clipboard here —
 * that permission is unreliable in CI — we intercept the event itself.
 */
async function armCopyListener(page: Page) {
  await page.evaluate(() => {
    window.__copied = null;
    document.addEventListener('copy', (e) => {
      window.__copied = {
        plain: e.clipboardData?.getData('text/plain') ?? '',
        html: e.clipboardData?.getData('text/html') ?? '',
      };
    });
  });
}

async function readCopied(page: Page) {
  return page.evaluate(() => window.__copied);
}

/**
 * Selects from the top-level heading through the first bold run in the
 * formatted-doc fixture, spanning a heading and a `<strong>` in one
 * selection. Built with two element lookups + createRange (not the
 * single-text-node selectText helper other specs use) because this
 * selection needs to cross block boundaries. Dispatches a bubbling mouseup
 * on document, same as useSelection listens for.
 */
async function selectHeadingThroughBold(page: Page) {
  await page.evaluate(() => {
    const prose = document.querySelector('.prose');
    if (!prose) throw new Error('.prose container not found');
    const heading = prose.querySelector('h1');
    const strong = Array.from(prose.querySelectorAll('strong')).find((el) =>
      el.textContent?.includes('bold text here'),
    );
    if (!heading?.firstChild || !strong?.firstChild) {
      throw new Error('expected heading/strong text nodes not found');
    }
    const range = document.createRange();
    range.setStart(heading.firstChild, 0);
    range.setEnd(strong.firstChild, strong.firstChild.textContent?.length ?? 0);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/** PUT the Quick comment setting directly, bypassing the settings UI. */
async function enableQuickComment(page: Page) {
  await page.request.put('/api/preferences', {
    data: { settings: { quickComment: true } },
  });
}

test.describe('Copy selection', () => {
  test('copying a rendered selection writes both text/plain and text/html', async ({ page }) => {
    await openFixture(page);
    await armCopyListener(page);
    await selectHeadingThroughBold(page);

    await page.keyboard.press('ControlOrMeta+c');

    await expect.poll(() => readCopied(page)).not.toBeNull();
    const copied = (await readCopied(page))!;
    expect(copied.plain).toContain('Formatted Document');
    expect(copied.plain).toContain('bold text here');
    expect(copied.html).toMatch(/<h1[\s>]/);
    expect(copied.html).toContain('<strong>');
  });

  test('a selection spanning two paragraphs keeps the blank line between them', async ({
    page,
  }) => {
    await openFixture(page);
    await armCopyListener(page);
    await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.prose p')];
      const first = ps.find((p) => p.textContent?.includes('First paragraph ends here'))!;
      const second = ps.find((p) => p.textContent?.includes('Second paragraph starts here'))!;
      const range = document.createRange();
      range.setStart(first.firstChild!, 0);
      range.setEnd(second.firstChild!, 20);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await page.keyboard.press('ControlOrMeta+c');

    await expect.poll(() => readCopied(page)).not.toBeNull();
    // In markdown a single newline is a soft break, so losing the blank line
    // pastes two paragraphs back as one. A Range reports no blank line at a
    // paragraph boundary; the Selection does.
    expect((await readCopied(page))!.plain).toContain('ends here.\n\nSecond paragraph');
  });

  test('Quick comment focusing the composer with a collapsed caret still copies the document selection', async ({
    page,
  }) => {
    await enableQuickComment(page);
    await openFixture(page);
    await armCopyListener(page);
    await selectHeadingThroughBold(page);

    // Quick comment locks the selection and moves focus into the composer
    // textarea the moment a selection is made (CommentForm.tsx). The caret
    // there is collapsed (no textarea-local selection), which is the
    // regression case: a naive check of "is focus in an editable element"
    // would wrongly let native copy win and paste nothing useful.
    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeFocused({ timeout: 5000 });

    await page.keyboard.press('ControlOrMeta+c');

    await expect.poll(() => readCopied(page)).not.toBeNull();
    const copied = (await readCopied(page))!;
    expect(copied.plain).toContain('Formatted Document');
    expect(copied.plain).toContain('bold text here');
    expect(copied.html).toMatch(/<h1[\s>]/);
    expect(copied.html).toContain('<strong>');
  });

  test('selecting text inside the composer textarea leaves native copy alone', async ({ page }) => {
    await enableQuickComment(page);
    await openFixture(page);
    await armCopyListener(page);
    await selectHeadingThroughBold(page);

    const textarea = page.getByPlaceholder('Add your comment...');
    await expect(textarea).toBeFocused({ timeout: 5000 });
    await textarea.fill('a comment worth selecting');

    // Select the composer's own text (not a collapsed caret). The handler
    // must stand down and let the browser's native copy run.
    await page.evaluate(() => {
      const el = document.activeElement as HTMLTextAreaElement;
      el.setSelectionRange(0, el.value.length);
    });

    await page.keyboard.press('ControlOrMeta+c');

    await expect.poll(() => readCopied(page)).not.toBeNull();
    const copied = (await readCopied(page))!;
    // Both flavors come back empty: our handler never called
    // clipboardData.setData, so nothing was written by the app for this
    // listener to read back. An empty string here means "native copy
    // proceeded", not "copy failed".
    expect(copied.plain).toBe('');
    expect(copied.html).toBe('');
  });
});
