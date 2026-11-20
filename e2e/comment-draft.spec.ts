import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE, TEST_DOC_2_BASELINE } from './helpers/fixture-baselines';
import { selectText } from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
// The server keeps an agent's before copy for the whole Playwright run, so
// the test that saves one works on a file of its own, written for the test
// and removed after the run, and leaves the shared fixtures without a diff.
const DIFF_DOC_1 = resolve(__dirname, 'fixtures/draft-diff-a.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, TEST_DOC_BASELINE);
  writeFileSync(FIXTURE_2, TEST_DOC_2_BASELINE);
  rmSync(DIFF_DOC_1, { force: true });
});

const form = (page: Page) => page.locator('[data-comment-form]');
const draftField = (page: Page) => page.getByPlaceholder('Add your comment...');
const selectionMark = (page: Page) => page.locator('mark.selection-highlight');
const tab = (page: Page, name: string) => page.locator('.h-11 button', { hasText: name }).first();

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE_1}`);
  await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

async function openFile(page: Page, path: string, heading: string) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(path);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

/** Select text, open the comment form on it and type a draft without posting. */
async function startDraft(page: Page, anchorText: string, draft: string) {
  await selectText(page, anchorText);
  const commentBtn = form(page).getByRole('button', { name: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await draftField(page).fill(draft);
}

async function runPaletteCommand(page: Page, label: string) {
  await page.keyboard.press(withMod('k'));
  const input = page.getByPlaceholder('Type a command...');
  await expect(input).toBeVisible({ timeout: 3000 });
  await input.fill(label);
  await input.press('Enter');
  await expect(input).toBeHidden({ timeout: 3000 });
}

async function roundTripThroughRawView(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
  await page.locator('button[title="Switch to rendered view"]').click();
  await expect(page.locator('.prose')).toBeVisible();
}

async function expectDraftBack(page: Page, anchorText: string, draft: string) {
  await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
  await expect(selectionMark(page)).toHaveText(anchorText);
}

test.describe('An unsent comment draft', () => {
  test('comes back with its text and highlight after a tab switch (#196)', async ({ page }) => {
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');
    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();

    const draft = 'A long comment the reader should not have to type twice';
    await startDraft(page, 'valid credentials', draft);

    // Away: the other file shows no form, and none of the draft.
    await tab(page, 'test-doc-2.md').click();
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    await expect(form(page)).toHaveCount(0);

    await tab(page, 'test-doc.md').click();
    await expectDraftBack(page, 'valid credentials', draft);
    // As it was left: the reader goes on typing.
    await expect(draftField(page)).toBeFocused();
  });

  test('comes back after the toolbar switches to raw view and back (#196)', async ({ page }) => {
    await openFixture(page);
    const draft = 'Checking the source before I finish this thought';
    await startDraft(page, 'brute force attacks', draft);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await expect(form(page)).toHaveCount(0);

    await page.locator('button[title="Switch to rendered view"]').click();
    await expectDraftBack(page, 'brute force attacks', draft);
  });

  test('comes back after the command palette switches to raw view and back', async ({ page }) => {
    await openFixture(page);
    const draft = 'Left through the palette this time';
    await startDraft(page, 'brute force attacks', draft);

    await runPaletteCommand(page, 'Switch to raw markdown');
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await expect(form(page)).toHaveCount(0);

    await runPaletteCommand(page, 'Switch to rendered view');
    await expectDraftBack(page, 'brute force attacks', draft);
  });

  test('is posted on the text it was started on after coming back', async ({ page }) => {
    await openFixture(page);
    const draft = 'Posted after a detour through the raw view';
    await startDraft(page, 'brute force attacks', draft);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await page.locator('button[title="Switch to rendered view"]').click();
    await expectDraftBack(page, 'brute force attacks', draft);

    await form(page).getByRole('button', { name: 'Comment' }).click();
    await expect(draftField(page)).toBeHidden({ timeout: 5000 });
    await expect
      .poll(() => readFileSync(FIXTURE_1, 'utf8'), { timeout: 5000 })
      .toMatch(/<!-- @comment\{[^\n]*Posted after a detour[^\n]*\} -->brute force attacks/);

    // Posted is done with: another trip does not bring it back.
    await roundTripThroughRawView(page);
    await expect(form(page)).toHaveCount(0);
  });

  test('stays gone when it is cancelled after coming back', async ({ page }) => {
    await openFixture(page);
    const draft = 'Brought back, then dropped';
    await startDraft(page, 'brute force attacks', draft);
    await roundTripThroughRawView(page);
    await expectDraftBack(page, 'brute force attacks', draft);

    await form(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(form(page)).toHaveCount(0);
    await roundTripThroughRawView(page);
    await expect(form(page)).toHaveCount(0);
  });

  test('is refused when the file changes after it came back', async ({ page }) => {
    await openFixture(page);
    const draft = 'Ready to post until the agent edited the file';
    await startDraft(page, 'brute force attacks', draft);
    await roundTripThroughRawView(page);
    await expectDraftBack(page, 'brute force attacks', draft);
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeEnabled();

    // Even away from the selected words: after any change, nothing on the
    // page proves which words the selection points at.
    const edited = TEST_DOC_BASELINE.replace('## Section Three', '## Section Three, revised');
    await expect(async () => {
      writeFileSync(FIXTURE_1, edited);
      await expect(page.locator('.prose')).toContainText('Section Three, revised', {
        timeout: 2000,
      });
    }).toPass({ timeout: 15_000 });
    await expect(selectionMark(page)).toHaveCount(0);

    await draftField(page).press(withMod('Enter'));
    await expect(form(page).getByRole('alert')).toContainText(
      'The file changed since you selected this text',
      {
        timeout: 5000,
      },
    );
    await expect(draftField(page)).toHaveValue(draft);
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
    expect(readFileSync(FIXTURE_1, 'utf8')).toBe(edited);
  });

  test('comes back saying it cannot be placed when the file lost its text meanwhile', async ({
    page,
  }) => {
    await openFixture(page);
    const draft = 'Written before the agent reworded this sentence';
    await startDraft(page, 'brute force attacks', draft);

    // In raw view the reader can watch the edit land, so the return below
    // happens against the changed file for certain.
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    writeFileSync(
      FIXTURE_1,
      TEST_DOC_BASELINE.replace('brute force attacks', 'credential stuffing'),
    );
    await expect(page.locator('.raw-view-table')).toContainText('credential stuffing', {
      timeout: 15_000,
    });

    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
    await expect(form(page).getByRole('alert')).toContainText(
      'The file changed since you selected this text',
    );
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
  });

  test('stays gone after Cancel', async ({ page }) => {
    await openFixture(page);
    await startDraft(page, 'brute force attacks', 'Changed my mind about this one');
    await form(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(form(page)).toHaveCount(0);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('.prose')).toBeVisible();

    await expect(form(page)).toHaveCount(0);
    await expect(selectionMark(page)).toHaveCount(0);
  });

  test('comes back when its tab is closed and the file is opened again', async ({ page }) => {
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');
    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();

    const draft = 'Closed the tab by accident mid-sentence';
    await startDraft(page, 'valid credentials', draft);

    await page.getByRole('button', { name: 'Close test-doc.md', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    await expect(form(page)).toHaveCount(0);

    await openFile(page, FIXTURE_1, 'Test Document');
    await expectDraftBack(page, 'valid credentials', draft);
  });

  test('comes back in view in a window shorter than the one it was written in', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');
    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();

    // The last line of the document, low in the tall window.
    const draft = 'Written near the bottom of a tall window';
    await startDraft(page, 'double-submit cookie pattern', draft);
    const writtenAt = await form(page).boundingBox();

    await tab(page, 'test-doc-2.md').click();
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    // Shorter than where the selection sat, so its saved place is off the page.
    const shorter = Math.floor(writtenAt!.y) - 150;
    await page.setViewportSize({ width: 1280, height: shorter });

    await tab(page, 'test-doc.md').click();
    await expect(draftField(page)).toBeVisible({ timeout: 5000 });
    await expect(draftField(page)).toHaveValue(draft);
    await expect(draftField(page)).toBeFocused();
    await expect(form(page)).toBeInViewport({ ratio: 1 });
  });

  test('does not stop the tab shortcut, which works from inside its field', async ({ page }) => {
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');
    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();

    const draft = 'Checking the other file without touching the mouse';
    await startDraft(page, 'valid credentials', draft);
    await expect(draftField(page)).toBeFocused();

    // Out of the field, mid-comment.
    await page.keyboard.press(withMod('Shift+BracketRight'));
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    await expect(form(page)).toHaveCount(0);

    // Back into it, with the caret where typing goes on.
    await page.keyboard.press(withMod('Shift+BracketLeft'));
    await expectDraftBack(page, 'valid credentials', draft);
    await expect(draftField(page)).toBeFocused();

    // And on past it: landing in the field must not end the cycling.
    await page.keyboard.press(withMod('Shift+BracketRight'));
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
  });

  test('is kept separately for each file', async ({ page }) => {
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');

    const draftTwo = 'A thought about the second file';
    await startDraft(page, 'additional information', draftTwo);

    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    const draftOne = 'A thought about the first file';
    await startDraft(page, 'valid credentials', draftOne);

    await tab(page, 'test-doc-2.md').click();
    await expectDraftBack(page, 'additional information', draftTwo);

    await tab(page, 'test-doc.md').click();
    await expectDraftBack(page, 'valid credentials', draftOne);
  });
});

const REPEAT_DOC =
  '# Repeat Doc\n\n' +
  'First clause: target phrase for alpha only.\n\n' +
  'Some filler text sits between the two clauses here.\n\n' +
  'Second clause: target phrase for beta only.\n';

/** Select the nth (0-based) occurrence of `text` in the rendered document. */
async function selectOccurrence(page: Page, text: string, n: number) {
  await page.evaluate(
    ({ text, n }) => {
      const walker = document.createTreeWalker(
        document.querySelector('.prose')!,
        NodeFilter.SHOW_TEXT,
      );
      let seen = 0;
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        let idx = node.textContent!.indexOf(text);
        while (idx >= 0) {
          if (seen++ === n) {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + text.length);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            const rect = range.getBoundingClientRect();
            node.parentElement!.dispatchEvent(
              new MouseEvent('mouseup', {
                bubbles: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
              }),
            );
            return;
          }
          idx = node.textContent!.indexOf(text, idx + 1);
        }
      }
      throw new Error(`occurrence ${n} of "${text}" not found`);
    },
    { text, n },
  );
}

/** Leave for the raw view, apply `edit` to the file, and come back once it shows. */
async function editWhileInRawView(page: Page, edited: string, shows: string, path = FIXTURE_1) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
  writeFileSync(path, edited);
  await expect(page.locator('.raw-view-table')).toContainText(shows, { timeout: 15_000 });
  await page.locator('button[title="Switch to rendered view"]').click();
  await expect(page.locator('.prose')).toBeVisible();
}

test.describe('An unsent comment draft on words the file repeats', () => {
  test.beforeEach(() => {
    writeFileSync(FIXTURE_1, REPEAT_DOC);
  });

  test('is not moved to another copy when its own was removed meanwhile', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE_1}`);
    await expect(page.getByRole('heading', { name: 'Repeat Doc' })).toBeVisible({
      timeout: 10_000,
    });
    await selectOccurrence(page, 'target phrase', 0);
    await form(page).getByRole('button', { name: 'Comment' }).click();
    const draft = 'About the alpha clause, which an agent then rewrote';
    await draftField(page).fill(draft);

    const edited = REPEAT_DOC.replace('First clause: target phrase', 'First clause: the plan');
    await editWhileInRawView(page, edited, 'the plan');

    await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
    await expect(form(page).getByRole('alert')).toContainText(
      'The file changed since you selected this text',
    );
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
    // Painting it would show the words in the beta clause as the selection.
    await expect(selectionMark(page)).toHaveCount(0);
    expect(readFileSync(FIXTURE_1, 'utf8')).toBe(edited);
  });

  test('is not posted on either copy when another is added above it', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE_1}`);
    await expect(page.getByRole('heading', { name: 'Repeat Doc' })).toBeVisible({
      timeout: 10_000,
    });
    await selectOccurrence(page, 'target phrase', 1);
    await form(page).getByRole('button', { name: 'Comment' }).click();
    const draft = 'About the beta clause';
    await draftField(page).fill(draft);

    const edited = REPEAT_DOC.replace(
      '# Repeat Doc\n\n',
      '# Repeat Doc\n\nAn opening line with a target phrase of its own.\n\n',
    );
    await editWhileInRawView(page, edited, 'An opening line');

    // Nothing on the page proves which copy is the reader's now.
    await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
    await expect(selectionMark(page)).toHaveCount(0);
    await expect(form(page).getByRole('alert')).toContainText(
      'The file changed since you selected this text',
    );
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
    await draftField(page).press(withMod('Enter'));
    await expect(draftField(page)).toHaveValue(draft);
    expect(readFileSync(FIXTURE_1, 'utf8')).toBe(edited);
  });
});

test.describe('Escape and an unsent comment draft', () => {
  test('a release after a tab switch leaves the draft handed back there', async ({ page }) => {
    await openFixture(page);
    await openFile(page, FIXTURE_2, 'Second Test Document');
    const parked = 'Parked on the second file';
    await startDraft(page, 'additional information', parked);
    await tab(page, 'test-doc.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();

    await startDraft(page, 'valid credentials', 'Cancelled with Escape');
    // Down in this file's form, which cancels it; up after the switch.
    await page.keyboard.down('Escape');
    await expect(form(page)).toHaveCount(0);
    await tab(page, 'test-doc-2.md').click();
    await expect(draftField(page)).toHaveValue(parked, { timeout: 5000 });
    await page.keyboard.up('Escape');

    await expect(draftField(page)).toHaveValue(parked);
    await expect(selectionMark(page)).toHaveText('additional information');
  });

  test('a full press on an untouched template clears it and keeps the form', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');
    const pill = form(page);
    await expect(pill.getByRole('button', { name: 'Comment' })).toBeVisible({ timeout: 5000 });
    // The pill's first template button prefills the form.
    await pill.locator('button').nth(1).click();
    await expect(draftField(page)).not.toHaveValue('');

    await page.keyboard.press('Escape');

    await expect(draftField(page)).toHaveValue('');
    await expect(draftField(page)).toBeVisible();
  });

  test('is not kept across a page reload', async ({ page }) => {
    await openFixture(page);
    await startDraft(page, 'valid credentials', 'Gone after a reload');
    await page.reload();
    // The address bar no longer names the file, so open it again.
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await expect(selectionMark(page)).toHaveCount(0);
  });
});

test.describe('An unsent comment draft and other changes to its file', () => {
  test('is still postable after a comment lands elsewhere in its file', async ({ page }) => {
    await openFixture(page);
    const draft = 'Written while an agent left a comment';
    await startDraft(page, 'brute force attacks', draft);

    // An agent comments on another paragraph while the reader is in raw view.
    // Comments leave the text the reader selected in alone.
    await editWhileInRawView(
      page,
      TEST_DOC_BASELINE.replace(
        'All passwords are hashed',
        '<!-- @comment{"id":"agent-1","anchor":"All passwords","text":"Which cost factor?","author":"Agent"} -->All passwords are hashed',
      ),
      'Which cost factor?',
    );

    await expectDraftBack(page, 'brute force attacks', draft);
    await expect(form(page).getByRole('alert')).toHaveCount(0);
    await form(page).getByRole('button', { name: 'Comment' }).click();
    await expect(draftField(page)).toBeHidden({ timeout: 5000 });
    await expect
      .poll(() => readFileSync(FIXTURE_1, 'utf8'), { timeout: 5000 })
      .toMatch(/<!-- @comment\{[^\n]*Written while an agent[^\n]*\} -->brute force attacks/);
  });

  test('started in the diff view, comes back in the plain view without a place to post', async ({
    page,
    request,
    baseURL,
  }) => {
    writeFileSync(DIFF_DOC_1, TEST_DOC_BASELINE);
    await page.goto(`/?file=${DIFF_DOC_1}`);
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await openFile(page, FIXTURE_2, 'Second Test Document');
    await tab(page, 'draft-diff-a.md').click();
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible();
    const captured = await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [DIFF_DOC_1], agentName: 'Claude' },
    });
    expect(captured.status()).toBe(201);
    // A removed paragraph above the selection, so the diff's text has more in
    // front of it than the plain view's.
    const edited = TEST_DOC_BASELINE.replace(/\n## Section One\n\n[^\n]*\n/, '\n');
    await expect(async () => {
      writeFileSync(DIFF_DOC_1, edited);
      await expect(page.getByRole('heading', { name: 'Section One' })).toHaveCount(0, {
        timeout: 2000,
      });
    }).toPass({ timeout: 15_000 });
    await page.locator('button[title="Show diff"]').click();
    await expect(page.locator('.rendered-diff-removed').first()).toBeVisible();

    const draft = 'Written while reading the diff';
    await startDraft(page, 'brute force attacks', draft);

    // Away and back: the tab comes back with the diff off.
    await tab(page, 'test-doc-2.md').click();
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible();
    await tab(page, 'draft-diff-a.md').click();

    await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
    await expect(page.locator('.rendered-diff-removed')).toHaveCount(0);
    await expect(form(page).getByRole('alert')).toContainText('selected in the diff view');
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
    await expect(selectionMark(page)).toHaveCount(0);
    expect(readFileSync(DIFF_DOC_1, 'utf8')).toBe(edited);
  });

  test('comes back over the diff overlay, postable, when the file is unchanged', async ({
    page,
    request,
    baseURL,
  }) => {
    writeFileSync(DIFF_DOC_1, TEST_DOC_BASELINE);
    await page.goto(`/?file=${DIFF_DOC_1}`);
    await expect(page.getByRole('heading', { name: 'Test Document', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const captured = await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [DIFF_DOC_1], agentName: 'Claude' },
    });
    expect(captured.status()).toBe(201);
    // An edit, so there is a diff: the toolbar's raw button turns the overlay
    // on only then.
    await expect(async () => {
      writeFileSync(
        DIFF_DOC_1,
        TEST_DOC_BASELINE.replace('## Section Three', '## Section Three, revised'),
      );
      await expect(page.locator('.prose')).toContainText('Section Three, revised', {
        timeout: 2000,
      });
    }).toPass({ timeout: 15_000 });
    await expect(page.locator('button[title="Show diff"]')).toBeEnabled({ timeout: 10_000 });

    const draft = 'Written before a look at the raw view';
    await startDraft(page, 'brute force attacks', draft);
    await roundTripThroughRawView(page);

    await expect(page.locator('button[title="Hide diff"]')).toBeVisible({ timeout: 5000 });
    await expect(draftField(page)).toHaveValue(draft, { timeout: 5000 });
    await expect(form(page).getByRole('alert')).toHaveCount(0);
    await expect(form(page).getByRole('button', { name: 'Comment' })).toBeEnabled();
  });
});
