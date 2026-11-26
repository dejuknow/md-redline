import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  clickCardAction,
  getCard,
  openCommentsDrawer,
  selectText,
  switchToListDensity,
} from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

// #213: an unsent reply or edit on a comment card survives leaving its file.
// Each test writes its own two files, so a comment can be deleted, resolved
// or answered on disk without touching the shared fixtures.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC_A = resolve(__dirname, 'fixtures/card-draft-a.md');
const DOC_B = resolve(__dirname, 'fixtures/card-draft-b.md');

const marker = (id: string, anchor: string, text: string, extra = '') =>
  `<!-- @comment{"id":"${id}","anchor":"${anchor}","text":"${text}","author":"User","timestamp":"2026-03-22T00:00:00.000Z"${extra},"replies":[]} -->`;

const DOC_A_TEXT = [
  '# Card Draft Doc',
  '',
  '## Section One',
  '',
  `The authentication system supports ${marker('cd-1', 'valid credentials', 'First note')}valid credentials for every user.`,
  '',
  '## Section Two',
  '',
  `Rate limiting prevents ${marker('cd-2', 'brute force attacks', 'Second note')}brute force attacks on the login form.`,
  '',
].join('\n');

const DOC_B_TEXT = '# Other Doc\n\nNothing to see here.\n';

test.beforeEach(async ({ page }) => {
  writeFileSync(DOC_A, DOC_A_TEXT);
  writeFileSync(DOC_B, DOC_B_TEXT);
  await resetTestAppState(page);
});

test.afterAll(() => {
  rmSync(DOC_A, { force: true });
  rmSync(DOC_B, { force: true });
});

const tab = (page: Page, name: string) =>
  page.locator('[data-doc-strip] button', { hasText: name }).first();
const headingA = (page: Page) => page.getByRole('heading', { name: 'Card Draft Doc' });
const headingB = (page: Page) => page.getByRole('heading', { name: 'Other Doc' });
const replyField = (page: Page, note: string) =>
  getCard(page, note).getByPlaceholder('Write a reply...');
const notice = (page: Page) => page.locator('[data-card-draft-notice]');

async function openBothFiles(page: Page) {
  await page.goto(`/?file=${DOC_A}`);
  await expect(headingA(page)).toBeVisible({ timeout: 10_000 });
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(DOC_B);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(headingB(page)).toBeVisible({ timeout: 10_000 });
  await tab(page, 'card-draft-a.md').click();
  await expect(headingA(page)).toBeVisible();
}

async function startReply(page: Page, note: string, text: string) {
  const card = getCard(page, note);
  await card.getByText(note).first().click();
  await card.getByRole('button', { name: 'Write a reply...' }).click();
  await replyField(page, note).fill(text);
}

async function goAwayAndBack(page: Page) {
  await tab(page, 'card-draft-b.md').click();
  await expect(headingB(page)).toBeVisible();
  await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);
  await tab(page, 'card-draft-a.md').click();
  await expect(headingA(page)).toBeVisible();
}

/** Write the file while its tab is in the background. The server debounces
 * watch events by 150ms and the background tab takes the new content from
 * them, so a second away is enough for it to land before coming back. */
async function rewriteWhileAway(page: Page, content: string) {
  await tab(page, 'card-draft-b.md').click();
  await expect(headingB(page)).toBeVisible();
  writeFileSync(DOC_A, content);
  await page.waitForTimeout(1000);
  await tab(page, 'card-draft-a.md').click();
  await expect(headingA(page)).toBeVisible();
}

test.describe('An unsent reply on a comment card', () => {
  test('comes back with its text and caret after a tab switch', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'A reply the reader should not have to type twice';
    await startReply(page, 'First note', draft);
    // Caret moved back into the text, before "twice".
    for (let i = 0; i < 5; i++) await replyField(page, 'First note').press('ArrowLeft');

    await goAwayAndBack(page);

    const field = replyField(page, 'First note');
    await expect(field).toHaveValue(draft, { timeout: 5000 });
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      draft.length - 5,
    );

    // Posts as a reply to the same comment.
    await getCard(page, 'First note').getByRole('button', { name: 'Reply', exact: true }).click();
    await expect
      .poll(() => readFileSync(DOC_A, 'utf8'))
      .toMatch(/"id":"cd-1"[^\n]*A reply the reader should not have to type twice/);
  });

  test('comes back after a round trip through the raw view', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'Checking the source before I finish';
    await startReply(page, 'Second note', draft);

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('.prose')).toBeVisible();

    await expect(replyField(page, 'Second note')).toHaveValue(draft, { timeout: 5000 });
  });

  test('comes back when the tab is closed and reopened', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'Closed the tab by accident';
    await startReply(page, 'First note', draft);

    await tab(page, 'card-draft-a.md').click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await menu.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(headingB(page)).toBeVisible();

    await tab(page, 'card-draft-b.md').click({ button: 'right' });
    await page
      .locator('.context-menu-enter')
      .getByRole('button', { name: 'Reopen Closed Tab' })
      .click();
    await expect(headingA(page)).toBeVisible({ timeout: 5000 });

    await expect(replyField(page, 'First note')).toHaveValue(draft, { timeout: 5000 });
  });

  test('stays gone once cancelled', async ({ page }) => {
    await openBothFiles(page);
    await startReply(page, 'First note', 'Never mind');
    await getCard(page, 'First note').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);

    await goAwayAndBack(page);
    await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test('comes back after an agent replied to the comment meanwhile', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'My follow-up';
    await startReply(page, 'First note', draft);

    const answered = DOC_A_TEXT.replace(
      '"replies":[]} -->valid',
      '"replies":[{"id":"r-agent","text":"Agent answer","author":"Agent","timestamp":"2026-03-22T00:01:00.000Z","agent":true}]} -->valid',
    );
    await rewriteWhileAway(page, answered);

    await expect(replyField(page, 'First note')).toHaveValue(draft, { timeout: 5000 });
    await expect(getCard(page, 'First note')).toContainText('Agent answer');
  });

  test('comes back when the prose changed around the comment meanwhile', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'Still about the same comment';
    await startReply(page, 'First note', draft);

    await rewriteWhileAway(page, DOC_A_TEXT.replace('## Section Two', '## Section Two, revised'));

    await expect(page.locator('.prose')).toContainText('Section Two, revised');
    await expect(replyField(page, 'First note')).toHaveValue(draft, { timeout: 5000 });
  });

  test('is kept aside, not attached elsewhere, when its comment was deleted meanwhile', async ({
    page,
  }) => {
    await openBothFiles(page);
    const draft = 'Reply to a comment that is about to vanish';
    await startReply(page, 'First note', draft);

    const withoutFirst = DOC_A_TEXT.replace(marker('cd-1', 'valid credentials', 'First note'), '');
    await rewriteWhileAway(page, withoutFirst);

    await expect(getCard(page, 'First note')).toHaveCount(0);
    await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);
    await expect(notice(page)).toContainText('comment it belongs to is no longer in this file', {
      timeout: 5000,
    });

    // Copy hands the text over; Discard drops it for good.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await notice(page).getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(draft);
    await notice(page).getByRole('button', { name: 'Discard' }).click();
    await expect(notice(page)).toHaveCount(0);
    await goAwayAndBack(page);
    await expect(notice(page)).toHaveCount(0);
  });

  test('is kept aside while its comment is resolved, and returns when it reopens', async ({
    page,
  }) => {
    await openBothFiles(page);
    const draft = 'Wait, one more thing';
    await startReply(page, 'Second note', draft);

    const resolved = DOC_A_TEXT.replace(
      marker('cd-2', 'brute force attacks', 'Second note'),
      marker('cd-2', 'brute force attacks', 'Second note', ',"status":"resolved"'),
    );
    await rewriteWhileAway(page, resolved);

    await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);
    await expect(notice(page)).toContainText('resolved', { timeout: 5000 });

    // Anchored density leaves resolved threads off the rail; the List shows them.
    await switchToListDensity(page);
    await clickCardAction(page, 'Second note', 'Reopen');
    await expect(notice(page)).toHaveCount(0);
    await expect(replyField(page, 'Second note')).toHaveValue(draft, { timeout: 5000 });
  });

  test('two cards keep their own drafts', async ({ page }) => {
    await openBothFiles(page);
    await startReply(page, 'First note', 'Draft on the first');
    // Opening the second card's composer closes the first one, but its text
    // is kept for when it is opened again.
    await startReply(page, 'Second note', 'Draft on the second');
    await expect(replyField(page, 'First note')).toHaveCount(0);

    await goAwayAndBack(page);
    await expect(replyField(page, 'Second note')).toHaveValue('Draft on the second', {
      timeout: 5000,
    });

    const first = getCard(page, 'First note');
    await first.getByText('First note').first().click();
    await first.getByRole('button', { name: 'Write a reply...' }).click();
    await expect(replyField(page, 'First note')).toHaveValue('Draft on the first');
  });

  test('lets the tab shortcut switch tabs from inside the reply field', async ({ page }) => {
    await openBothFiles(page);
    const draft = 'Cycling through tabs mid-reply';
    await startReply(page, 'First note', draft);

    await replyField(page, 'First note').press(withMod('Shift+BracketRight'));
    await expect(headingB(page)).toBeVisible();
    await page.keyboard.press(withMod('Shift+BracketLeft'));
    await expect(headingA(page)).toBeVisible();
    await expect(replyField(page, 'First note')).toHaveValue(draft, { timeout: 5000 });
  });
});

test('Escape in a card reply leaves an open comment form and its draft alone', async ({ page }) => {
  await openBothFiles(page);
  // A new-comment draft on a selection, then a reply on a card.
  await selectText(page, 'login form');
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await page.getByPlaceholder('Add your comment...').fill('New comment draft');
  await startReply(page, 'Second note', 'A reply to drop');

  await replyField(page, 'Second note').press('Escape');
  await expect(page.getByPlaceholder('Write a reply...')).toHaveCount(0);
  await expect(page.getByPlaceholder('Add your comment...')).toHaveValue('New comment draft');
});

test.describe('An unsent edit on a comment card', () => {
  const editField = (page: Page, note: string) =>
    getCard(page, note).locator('textarea:not([placeholder])');

  async function startEdit(page: Page, note: string, text: string) {
    await clickCardAction(page, note, 'Edit');
    await editField(page, note).fill(text);
  }

  test('comes back after a tab switch and saves onto the same comment', async ({ page }) => {
    await openBothFiles(page);
    await startEdit(page, 'First note', 'First note, reworded');

    await goAwayAndBack(page);

    const field = getCard(page, 'First note').locator('textarea');
    await expect(field).toHaveValue('First note, reworded', { timeout: 5000 });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => readFileSync(DOC_A, 'utf8'))
      .toMatch(/"id":"cd-1"[^\n]*"text":"First note, reworded"/);
  });

  test('is kept aside when the comment text changed meanwhile', async ({ page }) => {
    await openBothFiles(page);
    await startEdit(page, 'First note', 'My rewording');

    await rewriteWhileAway(
      page,
      DOC_A_TEXT.replace('"text":"First note"', '"text":"First note, edited elsewhere"'),
    );

    // Saving the draft would overwrite the other edit, so the editor stays
    // closed and the text is offered from the notice instead.
    await expect(getCard(page, 'First note, edited elsewhere').locator('textarea')).toHaveCount(0);
    await expect(notice(page)).toContainText('changed', { timeout: 5000 });
  });

  test('comes back in the comments drawer after a round trip through the raw view', async ({
    page,
  }) => {
    await openBothFiles(page);
    await startEdit(page, 'Second note', 'Reworded before checking the source');

    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await openCommentsDrawer(page);
    await expect(
      page.locator('[data-comments-drawer]').locator('textarea:not([placeholder])'),
    ).toHaveValue('Reworded before checking the source', { timeout: 5000 });
  });

  test('opens the drawer again for a draft written in it when its file comes back', async ({
    page,
  }) => {
    await openBothFiles(page);
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await openCommentsDrawer(page);
    const drawer = page.locator('[data-comments-drawer]');
    const card = drawer.locator('.group.rounded-lg', { hasText: 'First note' });
    await card.getByText('First note').first().click();
    await card.getByRole('button', { name: 'Write a reply...' }).click();
    await drawer.getByPlaceholder('Write a reply...').fill('Written in the drawer');
    // The desktop shell closes the drawer before it switches tabs.
    await page.getByRole('button', { name: 'Close comments drawer' }).click();
    await expect(drawer).toHaveCount(0);

    // Still the raw view, where the page shows the source.
    await tab(page, 'card-draft-b.md').click();
    await expect(page.locator('.raw-view-table')).toContainText('Nothing to see here.');
    await tab(page, 'card-draft-a.md').click();
    await expect(page.locator('.raw-view-table')).toContainText('Card Draft Doc');
    await expect(drawer.getByPlaceholder('Write a reply...')).toHaveValue('Written in the drawer', {
      timeout: 5000,
    });
  });
});
