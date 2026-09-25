import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { selectText } from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

// #100: opening an overlay while the viewer's context menu is up over an
// expanded comment draft closes the menu in the same commit, and the draft
// used to take focus back as the menu went: keystrokes meant for search went
// into the comment, and Escape in Settings discarded it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

const draft = (page: Page) => page.getByPlaceholder('Add your comment...');

/** An expanded draft with text in it, and the viewer's menu open over it. */
async function draftUnderMenu(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await selectText(page, 'valid credentials');
  await page.locator('[data-comment-form] button', { hasText: 'Comment' }).click();
  await draft(page).fill('my unsaved draft');
  await page.locator('mark.selection-highlight').first().click({ button: 'right' });
  await expect(page.locator('.context-menu-enter')).toHaveCount(1);
}

test('search opened over the menu keeps focus, not the draft', async ({ page }) => {
  await draftUnderMenu(page);
  await page.keyboard.press(withMod('f'));

  await expect(page.getByPlaceholder('Find...')).toBeFocused();
  await page.keyboard.type('login');
  await expect(draft(page)).toHaveValue('my unsaved draft');
});

test('Escape in Settings opened over the menu closes Settings and keeps the draft', async ({
  page,
}) => {
  await draftUnderMenu(page);
  await page.keyboard.press(withMod(','));
  await expect(draft(page)).not.toBeFocused();

  await page.keyboard.press('Escape');

  await expect(draft(page)).toHaveValue('my unsaved draft');
  // Focus the draft was owed when the menu closed is paid now that Settings
  // is gone, so the reader can keep typing where they were.
  await expect(draft(page)).toBeFocused();
});

test('Escape that dismisses the menu keeps the draft', async ({ page }) => {
  // The menu's Escape is the menu's; a second one is the reader's to give.
  await draftUnderMenu(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.context-menu-enter')).toHaveCount(0);
  await expect(draft(page)).toHaveValue('my unsaved draft');
});

test('Escape that closes the command palette keeps the draft', async ({ page }) => {
  // The palette stops the event, so a check on what handlers did could not
  // see it; the draft's fate is decided by what was open when Escape went down.
  await draftUnderMenu(page);
  await page.keyboard.press(withMod('k'));
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(draft(page)).toHaveValue('my unsaved draft');
});

test('holding Escape down in Settings keeps the draft', async ({ page }) => {
  // The first keydown closes Settings; the auto-repeats that follow find
  // nothing open, and must not undo that.
  await draftUnderMenu(page);
  await page.keyboard.press(withMod(','));
  await page.keyboard.down('Escape');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Escape'); // auto-repeat
  }
  await page.keyboard.up('Escape');
  await expect(draft(page)).toHaveValue('my unsaved draft');
});

test('Escape that cancels a confirm dialog keeps the draft', async ({ page }) => {
  // "Delete all comments" needs a comment to delete, and asks first.
  writeFileSync(
    FIXTURE,
    TEST_DOC_BASELINE.replace(
      'Rate limiting',
      '<!-- @comment{"id":"c1","anchor":"Rate limiting","text":"Why?","author":"Reviewer"} -->Rate limiting',
    ),
  );
  await draftUnderMenu(page);
  await page.keyboard.press(withMod('k'));
  await page.getByPlaceholder('Type a command...').fill('Delete all comments');
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Delete all comments' });
  await expect(confirm).toBeVisible();
  // The dialog listens for Escape from an effect that runs just after it
  // paints; a press in that first instant would reach nothing.
  await page.waitForTimeout(200);

  await page.keyboard.press('Escape');

  await expect(confirm).toHaveCount(0);
  await expect(draft(page)).toHaveValue('my unsaved draft');
});

test.describe('in a window too narrow for the rail', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('Escape that closes the comments drawer keeps the draft', async ({ page }) => {
    // The drawer closes on Escape without marking it handled, so only what
    // was open when Escape went down can tell the selection to stay.
    await draftUnderMenu(page);
    await page.keyboard.press(withMod('\\'));
    await expect(page.locator('[data-comments-drawer]')).toBeVisible();
    // The drawer listens for Escape from an effect that runs just after it
    // paints; a press in that first instant would reach nothing.
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-comments-drawer]')).toHaveCount(0);
    await expect(draft(page)).toHaveValue('my unsaved draft');
  });
});
