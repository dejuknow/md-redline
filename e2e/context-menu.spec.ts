import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_2_BASELINE, TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = TEST_DOC_BASELINE;
const FIXTURE_2_ORIGINAL = TEST_DOC_2_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  // The quick-comment test persists a setting, and the prefs file is shared
  // with every later spec (workers: 1). Six specs do not reset in beforeEach.
  clearPersistedPreferences();
});

async function openFixture(page: Page, fixture: string = FIXTURE_1) {
  await page.goto(`/?file=${fixture}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

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

/**
 * Select `text` and right-click the mark the viewer paints over it, which is
 * what a reader's right-click actually lands on. Returns the open menu.
 */
async function openSelectionMenu(page: Page, text: string) {
  await selectText(page, text);
  const highlight = page.locator('mark.selection-highlight').first();
  await expect(highlight).toBeVisible({ timeout: 5000 });
  await highlight.click({ button: 'right' });
  return page.locator('.context-menu-enter');
}

async function addComment(page: Page, anchorText: string, commentText: string) {
  await selectText(page, anchorText);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

async function openSecondFile(page: Page) {
  await page.locator('button[title="Open file"]').click();
  await page.getByPlaceholder('File path or name...').fill(FIXTURE_2);
  await page.getByPlaceholder('File path or name...').press('Enter');
  await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Context menu tests
// ---------------------------------------------------------------------------

test.describe('Context menu on comment highlight', () => {
  test('right-clicking a highlight shows context menu with comment actions', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Ctx menu test');

    // Right-click on the highlight mark
    const highlight = page.locator('mark.comment-highlight').first();
    await highlight.click({ button: 'right' });

    // Context menu should appear with Edit and Delete actions
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Edit')).toBeVisible();
    await expect(menu.getByText('Delete')).toBeVisible();
  });

  test('clicking Delete in context menu removes the comment', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Delete via ctx');

    const highlight = page.locator('mark.comment-highlight').first();
    await highlight.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await menu.getByText('Delete').click();

    // Comment should be removed
    await expect(page.getByText('Delete via ctx')).not.toBeVisible();
  });
});

test.describe('Context menu on a text selection', () => {
  test('right-clicking a selection shows the selection context menu', async ({ page }) => {
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');

    await expect(menu).toBeVisible();
    await expect(menu.getByText('Copy', { exact: true })).toBeVisible();
  });

  test('the selection survives the right-click that opened the menu', async ({ page }) => {
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');
    await expect(menu).toBeVisible();

    // The menu's items act on the selection. If the right-click's own mouseup
    // clears it, the menu is left floating over text it can no longer touch.
    // The painted mark is the evidence here: the pill is deliberately hidden
    // while the menu is up (see the one-surface test below), so its absence
    // would prove nothing either way.
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible();
  });

  test('Comment in the selection menu opens the composer on that selection', async ({ page }) => {
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');
    await menu.getByText('Comment', { exact: true }).click();

    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible({ timeout: 5000 });
  });

  test('right-clicking a selection opens the menu with quick comment on', async ({ page }) => {
    // Quick comment opens the composer the moment a selection is made, and the
    // composer dismisses itself on an outside mousedown. A right-click on your
    // own selection is such a mousedown, so this is a second way the menu was
    // lost, independent of the one the tests above cover.
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 10_000,
    });
    const menu = await openSelectionMenu(page, 'valid credentials');

    await expect(menu).toBeVisible();
    await expect(menu.getByText('Copy', { exact: true })).toBeVisible();
  });

  test('a right-click the app cannot answer falls back to the browser menu', async ({ page }) => {
    await openFixture(page);

    // A painted mark the app holds no selection for. The consumer refuses to
    // build a menu for it, so suppressing the native one would leave the reader
    // with no menu at all: no Copy, no spellcheck, no Inspect.
    await page.evaluate(() => {
      const p = document.querySelector('.prose p');
      const mark = document.createElement('mark');
      mark.className = 'selection-highlight';
      mark.textContent = 'orphaned highlight';
      p?.appendChild(mark);
      (window as unknown as { __prevented: boolean | null }).__prevented = null;
      document.addEventListener('contextmenu', (e) => {
        (window as unknown as { __prevented: boolean | null }).__prevented = e.defaultPrevented;
      });
    });

    await page.locator('mark.selection-highlight').last().click({ button: 'right' });

    await expect(page.locator('.context-menu-enter')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean | null }).__prevented),
    ).toBe(false);
  });

  test('right-clicking away from the selection clears it, as any click does', async ({ page }) => {
    await openFixture(page);
    await selectText(page, 'valid credentials');
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });

    // Sparing every secondary button everywhere would leave this selection
    // committed while its pill floats over unrelated text, and the next menu
    // would build on it instead of on what the reader just pointed at.
    await page.locator('.prose h1').first().click({ button: 'right' });

    await expect(page.locator('mark.selection-highlight')).toHaveCount(0);
    await expect(page.locator('[data-comment-form]')).toHaveCount(0);
  });

  test('Shift+right-click leaves the browser menu alone', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => {
      (window as unknown as { __prevented: boolean | null }).__prevented = null;
      document.addEventListener('contextmenu', (e) => {
        (window as unknown as { __prevented: boolean | null }).__prevented = e.defaultPrevented;
      });
    });
    await selectText(page, 'valid credentials');
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });

    await page
      .locator('mark.selection-highlight')
      .first()
      .click({ button: 'right', modifiers: ['Shift'] });

    await expect(page.locator('.context-menu-enter')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean | null }).__prevented),
    ).toBe(false);
  });

  test('Comment from the menu opens the composer and leaves selection usable after', async ({
    page,
  }) => {
    // Quick comment on: the composer is already open when the menu is used, so
    // the mousedown that picks an item is an outside press on an empty form.
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');
    await menu.getByText('Comment', { exact: true }).click();

    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible();

    // And the next selection still works: a lock taken on a cleared selection
    // is never released, so everything after it is silently ignored.
    await page.keyboard.press('Escape');
    const second = await openSelectionMenu(page, 'bcrypt');
    await expect(second).toBeVisible();
  });

  test('the pill hides while the menu is open, and comes back when it closes', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await selectText(page, 'valid credentials');
    await expect(page.locator('[data-comment-form]')).toBeVisible({ timeout: 5000 });

    const menu = page.locator('.context-menu-enter');
    await page.locator('mark.selection-highlight').first().click({ button: 'right' });

    // One surface at a time: both carry Comment and the same templates, and the
    // submenu opens straight over the pill's own template row.
    await expect(menu).toBeVisible();
    await expect(page.locator('[data-comment-form]')).toBeHidden();

    // Copy closes the menu without ending the selection, so the pill returns.
    await menu.getByText('Copy', { exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-comment-form]')).toBeVisible();
  });

  test('an expanded composer hides too, and comes back with its draft', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    await openFixture(page);
    await selectText(page, 'valid credentials');
    const draft = page.getByPlaceholder('Add your comment...');
    await expect(draft).toBeVisible({ timeout: 5000 });
    await draft.fill('half a thought');

    const menu = page.locator('.context-menu-enter');
    await page.locator('mark.selection-highlight').first().click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(page.locator('[data-comment-form]')).toBeHidden();

    // Hidden, not unmounted: the component keeps its state while it renders
    // nothing, so the half-written comment is still there afterwards.
    await menu.getByText('Copy', { exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('half a thought');
  });

  test('opening an overlay closes the context menu', async ({ page }) => {
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');
    await expect(menu).toBeVisible();

    await page.keyboard.press(withMod('k'));

    // Two stacked surfaces again otherwise: the palette renders over a menu
    // that is still live underneath it.
    await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 5000 });
    await expect(menu).toHaveCount(0);
  });

  test('a right-click that is not on a selection leaves the browser menu alone', async ({
    page,
  }) => {
    await openFixture(page);
    await page.evaluate(() => {
      (window as unknown as { __prevented: boolean | null }).__prevented = null;
      document.addEventListener('contextmenu', (e) => {
        (window as unknown as { __prevented: boolean | null }).__prevented = e.defaultPrevented;
      });
    });

    await page.locator('.prose p').first().click({ button: 'right' });

    await expect(page.locator('.context-menu-enter')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean | null }).__prevented),
    ).toBe(false);
  });

  test('ctrl+click, the macOS secondary click, keeps the selection', async ({ page }) => {
    // Blink converts ctrl+click to contextmenu on macOS only, and
    // isSecondaryClick counts the chord only there, so this asserts nothing on
    // the Linux runner the e2e job uses. Same gate as advanced.spec.ts.
    test.skip(process.platform !== 'darwin', 'ctrl+click is the secondary click on macOS only');
    await openFixture(page);
    await selectText(page, 'valid credentials');
    const mark = page.locator('mark.selection-highlight').first();
    await expect(mark).toBeVisible({ timeout: 5000 });
    const box = await mark.boundingBox();

    // macOS sends contextmenu with button 0 and ctrlKey set, so a guard that
    // tests the button alone misses the platform's own secondary click.
    await page.keyboard.down('Control');
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.up('Control');

    await expect(page.locator('.context-menu-enter')).toBeVisible();
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible();
  });

  test('a multi-line draft keeps its size and caret through the menu', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.request.put('/api/preferences', { data: { settings: { quickComment: true } } });
    await openFixture(page);
    await selectText(page, 'valid credentials');
    const draft = page.getByPlaceholder('Add your comment...');
    await expect(draft).toBeVisible({ timeout: 5000 });
    await draft.fill('one\ntwo\nthree\nfour\nfive');
    const grown = (await draft.boundingBox())!.height;
    expect(grown).toBeGreaterThan(60);

    const menu = page.locator('.context-menu-enter');
    // Dispatched rather than clicked: a draft this tall grows the composer over
    // its own anchor, so a real click cannot reach the mark and the test would
    // be measuring layout rather than the hide-and-restore it exists for.
    await page
      .locator('mark.selection-highlight')
      .first()
      .dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    await expect(menu).toBeVisible();
    await menu.getByText('Copy', { exact: true }).click();
    await expect(menu).toHaveCount(0);

    // The textarea auto-sizes on input and focuses on expand, and neither
    // effect re-runs on a remount, so a discarded node comes back one line
    // tall with the caret gone and lines two onward unreachable.
    await expect(draft).toHaveValue('one\ntwo\nthree\nfour\nfive');
    expect((await draft.boundingBox())!.height).toBe(grown);
    expect(await draft.evaluate((el) => document.activeElement === el)).toBe(true);
  });

  test('switching tabs closes the menu', async ({ page }) => {
    await openFixture(page);
    await openSecondFile(page);
    const menu = await openSelectionMenu(page, 'details section');
    await expect(menu).toBeVisible();

    await page.keyboard.press(withMod('Shift+['));
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 5000,
    });

    // Its items act on a SelectionInfo captured in the document that is no
    // longer on screen; Comment would anchor into the wrong file.
    await expect(menu).toHaveCount(0);
  });

  test('a live range that is not the committed selection gets no menu', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await selectText(page, 'valid credentials');
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press(withMod('Shift+m')); // lock it
    await page.waitForTimeout(200);

    // Drag out a real selection elsewhere. handleMouseUp bails while locked, so
    // the native range is now different text from the committed selection.
    const box = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.querySelector('.prose') as Node,
        NodeFilter.SHOW_TEXT,
      );
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.indexOf('Rate limiting') ?? -1;
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 'Rate limiting'.length);
          const r = range.getBoundingClientRect();
          return { x: r.left, y: r.top + r.height / 2, w: r.width };
        }
      }
      return null;
    });
    if (!box) throw new Error('target text not found');
    await page.mouse.move(box.x + 1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w - 1, box.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Rate limiting');
    // The precondition this test exists for: the drag was ignored, so the
    // committed selection is still the first passage. Without asserting it, a
    // lock that had not landed yet would make this test pass for no reason.
    expect(await page.locator('mark.selection-highlight').first().textContent()).toContain(
      'valid credentials',
    );

    await page.mouse.click(box.x + box.w / 2, box.y, { button: 'right' });
    await page.waitForTimeout(300);

    // Opening here would put a menu over one passage whose every item acts on
    // another: Copy writes the old text, Comment anchors to it.
    await expect(page.locator('.context-menu-enter')).toHaveCount(0);
  });

  test('a drag released in the empty area below the text still commits', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 10_000,
    });

    // Scroll to the end first. The empty area below the text only exists at the
    // bottom of the document, and on a taller viewport-to-content ratio than
    // this machine happens to have, "below the prose" is off screen entirely:
    // the release would land back on text and this would pass while testing an
    // ordinary drag.
    await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTop = scroller.scrollHeight;
      const pane = document.querySelector('.doc-sheet')?.parentElement;
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
    await page.waitForTimeout(400);

    const geom = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.prose p')];
      const last = ps[ps.length - 1].getBoundingClientRect();
      return {
        x: last.left + 5,
        y: last.top + last.height / 2,
        bottom: last.bottom,
        viewport: window.innerHeight,
      };
    });
    const releaseY = Math.min(geom.bottom + 60, geom.viewport - 10);
    expect(releaseY).toBeGreaterThan(geom.bottom);

    await page.mouse.move(geom.x, geom.y);
    await page.mouse.down();
    await page.mouse.move(geom.x + 150, releaseY, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-comment-form]')).toBeVisible();

    const menu = page.locator('.context-menu-enter');
    await page.locator('mark.selection-highlight').first().click({ button: 'right' });
    await expect(menu).toBeVisible();
  });

  test('Copy as Markdown hands back the document source for a whole block', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    // A whole paragraph: the boundaries line up with a block, so this is the
    // file's own bytes rather than a reconstruction.
    await page.evaluate(() => {
      const p = [...document.querySelectorAll('.prose p')].find((el) =>
        el.textContent?.includes('valid credentials'),
      )!;
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const menu = page.locator('.context-menu-enter');
    await page.locator('mark.selection-highlight').first().click({ button: 'right' });
    await menu.getByText('Copy as Markdown', { exact: true }).click();

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(
        'The authentication system supports email and password login. Users must provide valid credentials to access the application. The system validates all inputs before processing.',
      );
  });

  test('Copy in the selection menu puts the selected text on the clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    const menu = await openSelectionMenu(page, 'valid credentials');
    await menu.getByText('Copy', { exact: true }).click();

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe('valid credentials');
  });
});

test.describe('Context menu on tab', () => {
  test('right-clicking a tab shows tab context menu', async ({ page }) => {
    await openFixture(page);

    // Close the explorer so tab area is fully unobscured
    if (await page.locator('[data-sidebar-panel]').count()) {
      await page.locator('[data-sidebar-panel] button[title="Close panel"]').click();
    }
    await page.waitForTimeout(300);

    const tab = page.locator('.h-11 button', { hasText: 'test-doc.md' }).first();
    await expect(tab).toBeVisible();
    await tab.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Close', { exact: true }).first()).toBeVisible();
    await expect(menu.getByText('Copy Path')).toBeVisible();
    await expect(menu.getByText('Copy File Name')).toBeVisible();
  });

  test("Reveal in Explorer Sidebar opens the Explorer at the file's parent dir", async ({
    page,
  }) => {
    await openFixture(page);

    // Start with the Explorer closed so we can verify the action opens it.
    if (await page.locator('[data-sidebar-panel]').count()) {
      await page.locator('[data-sidebar-panel] button[title="Close panel"]').click();
    }
    await page.waitForTimeout(300);

    const tab = page.locator('.h-11 button', { hasText: 'test-doc.md' }).first();
    await tab.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Reveal in Explorer Sidebar').click();

    // The expanded sidebar panel should now be open.
    await expect(page.locator('[data-sidebar-panel]')).toBeVisible();

    // Explorer should be navigated to the fixture's parent dir — the fixture
    // file row (w-full text-left, titled with its full path) should be listed.
    await expect(page.locator(`button.w-full.text-left[title="${FIXTURE_1}"]`)).toBeVisible({
      timeout: 5_000,
    });
  });

  test('Close Others closes all except the right-clicked tab', async ({ page }) => {
    await openFixture(page);
    await openSecondFile(page);

    if (await page.locator('[data-sidebar-panel]').count()) {
      await page.locator('[data-sidebar-panel] button[title="Close panel"]').click();
    }
    await page.waitForTimeout(300);

    const tab1 = page.locator('.h-11 button', { hasText: 'test-doc.md' }).first();
    await tab1.click({ button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Close Others').click();

    await expect(page.locator('.h-11 button', { hasText: 'test-doc-2.md' })).not.toBeVisible();
    await expect(page.locator('.h-11 button', { hasText: 'test-doc.md' }).first()).toBeVisible();
  });
});

test.describe('Context menu on a rail comment card', () => {
  test('right-clicking a comment card shows the context menu', async ({ page }) => {
    await openFixture(page);

    // Close the explorer to give the rail more room
    await page.locator('[data-sidebar-panel] button[title="Close panel"]').click();
    await page.waitForTimeout(300);

    await addComment(page, 'valid credentials', 'Rail ctx test');

    // Use coordinates-based right-click for reliability
    const card = getCard(page, 'Rail ctx test');
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });

    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Delete')).toBeVisible();
    await expect(menu.getByText('Copy Anchor Text')).toBeVisible();
    await expect(menu.getByText('Copy Comment Text')).toBeVisible();
    await expect(menu.getByText('Scroll to Highlight')).toBeVisible();
  });
});
