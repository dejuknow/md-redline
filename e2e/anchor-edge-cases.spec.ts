import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ANCHOR_EDGE_CASES_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `anchor-edges-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'anchor-edge-cases-doc.md');
  writeFileSync(fixturePath, ANCHOR_EDGE_CASES_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => clearPersistedPreferences());

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Anchor Edge Cases' })).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Build a DOM Range that spans `startText` … `endText` inside the rendered
 * markdown. The range starts at the first occurrence of `startText` and ends
 * at the end of the first occurrence of `endText` after that. Used for
 * cross-element selections (e.g. multiple bullets in a blockquote).
 */
async function selectFromTo(page: Page, startText: string, endText: string) {
  await page.evaluate(
    ({ startText, endText }) => {
      const root = document.querySelector('.prose') ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (!startNode) {
          const idx = node.textContent?.indexOf(startText) ?? -1;
          if (idx >= 0) {
            startNode = node;
            startOffset = idx;
          }
        }
        if (startNode) {
          const idx = node.textContent?.indexOf(endText) ?? -1;
          if (idx >= 0) {
            endNode = node;
            endOffset = idx + endText.length;
            break;
          }
        }
      }
      if (!startNode || !endNode) {
        throw new Error(
          `Could not build range "${startText}" … "${endText}" (start=${!!startNode}, end=${!!endNode})`,
        );
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const rect = range.getBoundingClientRect();
      endNode.parentElement?.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom - 2,
        }),
      );
    },
    { startText, endText },
  );
}

async function selectSingleText(page: Page, text: string) {
  await page.evaluate((target) => {
    const root = document.querySelector('.prose') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.textContent?.indexOf(target) ?? -1;
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + target.length);
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
    throw new Error(`Text "${target}" not found in rendered markdown`);
  }, text);
}

async function submitCommentForm(page: Page, body: string) {
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(body);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5000 });
}

test.describe('Comments anchor cleanly across markdown constructs', () => {
  test('blockquoted task list', async ({ page }) => {
    await openFixture(page);
    await selectFromTo(page, 'First item to address', 'Third item still pending');
    await submitCommentForm(page, 'check the launch checklist');

    await expect(page.getByText('check the launch checklist')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('inline HTML kbd tags', async ({ page }) => {
    await openFixture(page);
    // Selection crosses multiple text nodes (text + `<kbd>` + text + `<kbd>` + text)
    await selectFromTo(page, 'Press', 'to copy the selection.');
    await submitCommentForm(page, 'simplify the keyboard hint');

    await expect(page.getByText('simplify the keyboard hint')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('reference-style link span', async ({ page }) => {
    await openFixture(page);
    // Selection spans `[the docs][docs]` + " and " + `[the spec][spec]`
    await selectFromTo(page, 'See', 'for full details.');
    await submitCommentForm(page, 'fold these into a single link');

    await expect(page.getByText('fold these into a single link')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('escaped characters in prose', async ({ page }) => {
    await openFixture(page);
    await selectSingleText(page, 'Use *literal asterisks* not bold');
    await submitCommentForm(page, 'this paragraph escapes asterisks');

    await expect(page.getByText('this paragraph escapes asterisks')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });

  test('inline code: marker lands before the backticks and still highlights the code', async ({
    page,
  }) => {
    // #123. The marker used to go inside the backticks, where every other
    // renderer shows it as literal code.
    writeFileSync(
      fixturePath,
      '# Anchor Edge Cases\n\nCall `computeToken` first, and write `<!--` to open a note.\n\nLater text here.\n',
    );
    await openFixture(page);
    await selectSingleText(page, 'computeToken');
    await submitCommentForm(page, 'why this helper');

    await expect
      .poll(() => readFileSync(fixturePath, 'utf8'))
      .toMatch(/Call <!-- @comment\{.*?\} -->`computeToken` first/);
    await expect(page.locator('mark.comment-highlight')).toHaveText('computeToken');
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();

    // The `<!--` in code no longer drags a later marker up into it.
    await selectSingleText(page, 'Later text');
    await submitCommentForm(page, 'and this one');
    await expect
      .poll(() => readFileSync(fixturePath, 'utf8'))
      .toMatch(/\n\n<!-- @comment\{.*?\} -->Later text here\.\n$/);
  });

  test('a selection from a heading through a table anchors where it started (#93)', async ({
    page,
  }) => {
    // A table renders as cells, not as its | source |, so an anchor crossing
    // one used to be a string the file did not contain, and the comment was
    // silently re-anchored, sometimes mid-word. The selection text now
    // separates cells with tabs, which the matcher finds.
    writeFileSync(
      fixturePath,
      '# Anchor Edge Cases\n\n## 2. Onboarding events\n\nFired during the wizard.\n\n| Event | Priority |\n|---|---|\n| signup | high |\n| invite | low |\n\nAfter the table.\n',
    );
    await openFixture(page);
    await selectFromTo(page, '2. Onboarding events', 'low');
    await submitCommentForm(page, 'covers the whole table');

    await expect
      .poll(() => readFileSync(fixturePath, 'utf8'))
      .toMatch(/## <!-- @comment\{.*?\} -->2\. Onboarding events/s);
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
    await expect(page.getByText(/re-anchored/i)).toHaveCount(0);
    const marked = await page.locator('mark.comment-highlight').allTextContents();
    expect(marked).toEqual(expect.arrayContaining(['2. Onboarding events', 'Event', 'low']));
  });
});

test.describe('HTML entities in the file', () => {
  test('comments on text with an html entity', async ({ page }) => {
    // `&amp;` renders as `&`. The anchor used to be searched for verbatim, so a
    // selection like this had no match and the comment fell back to a guess.
    writeFileSync(fixturePath, '# Anchor Edge Cases\n\nShip it once Tom &amp; Jerry sign off.\n');
    await openFixture(page);
    await selectSingleText(page, 'Tom & Jerry');
    await submitCommentForm(page, 'which Tom and which Jerry');

    await expect
      .poll(() => readFileSync(fixturePath, 'utf8'))
      .toMatch(/once <!-- @comment\{.*?\} -->Tom &amp; Jerry sign off\./);

    await openFixture(page);
    await expect(page.locator('mark.comment-highlight')).toHaveText('Tom & Jerry');
    await expect(page.getByText('which Tom and which Jerry')).toBeVisible();
    await expect(page.getByText(/Needs re-anchoring/)).not.toBeVisible();
  });
});

test.describe('A selection the file cannot place', () => {
  const FOOTNOTE_DOC = '# Anchor Edge Cases\n\nClaim one[^n] and two.\n\n[^n]: Note.\n';

  /** Select from `one` through `and`, across the footnote's superscript number. */
  async function selectAcrossFootnote(page: Page) {
    await selectFromTo(page, 'one', 'and');
    // The rendered selection carries the footnote's number, which the file
    // spells `[^n]`, so no single span of the source matches it. The app swaps
    // the native selection for highlight marks, so read the number from those.
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
    const painted = (await page.locator('mark.selection-highlight').allTextContents()).join('');
    expect(painted).toMatch(/one\s*1\s*and/);
  }

  test('flags a selection that crosses a footnote number', async ({ page }) => {
    writeFileSync(fixturePath, FOOTNOTE_DOC);
    await openFixture(page);
    await selectAcrossFootnote(page);

    const form = page.locator('[data-comment-form]');
    await expect(form.getByRole('status')).toContainText('Can’t comment on this text.');
    await expect(form.getByRole('status')).toContainText('Try a shorter selection.');
    await expect(form.getByRole('button', { name: 'Comment' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Add your comment...')).toHaveCount(0);

    // Cmd+Enter is the keyboard route to the composer, and it stays shut.
    await page.keyboard.press(withMod('Enter'));
    await expect(page.getByPlaceholder('Add your comment...')).toHaveCount(0);
    await expect(form.getByRole('status')).toBeVisible();

    // The context menu offers Comment, disabled.
    const highlight = page.locator('mark.selection-highlight').first();
    await expect(highlight).toBeVisible({ timeout: 5000 });
    await highlight.click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
    await expect(page.getByPlaceholder('Add your comment...')).toHaveCount(0);
    expect(readFileSync(fixturePath, 'utf8')).toBe(FOOTNOTE_DOC);
  });

  test('quick comment does not open a form on a selection the file cannot place', async ({
    page,
  }) => {
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    writeFileSync(fixturePath, FOOTNOTE_DOC);
    await openFixture(page);
    await selectAcrossFootnote(page);

    await expect(page.locator('[data-comment-form]').getByRole('status')).toContainText(
      'Can’t comment on this text.',
    );
    await expect(page.getByPlaceholder('Add your comment...')).toHaveCount(0);
    expect(readFileSync(fixturePath, 'utf8')).toBe(FOOTNOTE_DOC);
  });
});

test.describe('A comment the file cannot place', () => {
  test('keeps the form open with the draft when the file changes under it (#191)', async ({
    page,
  }) => {
    // The selection places when it is made, so the up-front check passes. The
    // file then loses that text before Comment is pressed, which is the case
    // the failed-submit state still exists for.
    const original = '# Anchor Edge Cases\n\nShip the blue release today.\n\nOther text.\n';
    writeFileSync(fixturePath, original);
    await openFixture(page);
    await selectSingleText(page, 'blue release');

    const form = page.locator('[data-comment-form]');
    const commentBtn = form.getByRole('button', { name: 'Comment' });
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
    await commentBtn.click();
    const draft = 'A long comment the reader should not have to type twice';
    await page.getByPlaceholder('Add your comment...').fill(draft);

    // Rewrite the file without the selected text and wait for the app to load it.
    const changed = '# Anchor Edge Cases\n\nShip the green launch today.\n\nOther text.\n';
    writeFileSync(fixturePath, changed);
    await expect(page.locator('.prose')).toContainText('green launch', { timeout: 15_000 });

    await form.getByRole('button', { name: 'Comment' }).click();

    await expect(page.getByText(/Couldn't anchor that comment/)).toBeVisible();
    await expect(page.getByPlaceholder('Add your comment...')).toHaveValue(draft);
    await expect(form.getByRole('alert')).toContainText('find this text in the file');
    expect(readFileSync(fixturePath, 'utf8')).toBe(changed);

    // The text coming back clears the failure and Comment works again.
    writeFileSync(fixturePath, original);
    await expect(page.locator('.prose')).toContainText('blue release', { timeout: 15_000 });
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Comment' })).toBeEnabled();
  });
});
