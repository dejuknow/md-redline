import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { addComment } from './helpers/comments';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

// The rail needs roughly 888px of content width to fit (see COL_MIN /
// RAIL_FOOTPRINT in src/lib/page-geometry.ts). A narrow window guarantees it
// never shows, so the popover is the only single-comment surface; a wide one
// guarantees the rail shows instead.
const NARROW_VIEWPORT = { width: 800, height: 900 };
const WIDE_VIEWPORT = { width: 1700, height: 950 };

test.use({ viewport: NARROW_VIEWPORT });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `comment-popover-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // The popover's enter animation and the rail/column width change are both
  // motion-safe; disable motion so assertions read settled state rather
  // than a mid-transition one.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

function popover(page: Page) {
  return page.locator('[data-comment-popover]');
}

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

async function clickCardAction(page: Page, commentText: string, actionName: string) {
  const card = getCard(page, commentText);
  await card.hover();
  await card.getByRole('button', { name: actionName, exact: true }).click({ force: true });
}

/** Enable a boolean setting via the Settings panel toggle */
async function toggleSetting(page: Page, settingName: string) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  const settingLabel = panel.locator('label', { hasText: settingName });
  await settingLabel.locator('button[role="switch"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

async function switchToListDensity(page: Page) {
  await page.locator('[data-rail-header] button', { hasText: 'List' }).click();
}

async function switchToAnchoredDensity(page: Page) {
  await page.locator('[data-rail-header] button', { hasText: 'Anchored' }).click();
}

/**
 * Turn the resolve workflow on and settle one comment. The Resolve action
 * lives on the List surface's cards, so the density switch is part of the
 * sequence rather than something each test remembers to do.
 */
async function resolveComment(page: Page, commentText: string) {
  await toggleSetting(page, 'Enable resolve workflow');
  await switchToListDensity(page);
  await clickCardAction(page, commentText, 'Resolve');
}

test.describe('Highlight popover (rail-hidden contexts)', () => {
  test('clicking a highlight opens the popover with the comment text and author byline; Esc and an outside click both close it', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Popover comment one');

    // Creation while the rail is hidden auto-opens the popover; close it so
    // this test can exercise the click-to-open path on its own.
    const pop = popover(page);
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();

    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Popover comment one');
    await expect(pop).toContainText('User'); // default author byline

    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();

    // Reopen, then close via a click on the prose outside the popover.
    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toBeVisible();
    await page.getByRole('heading', { name: 'Section Three' }).click();
    await expect(pop).not.toBeVisible();
  });

  test('replying inside the popover lands the reply in the file', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Popover reply target');

    const pop = popover(page);
    await expect(pop).toBeVisible();

    await pop.getByRole('button', { name: 'Reply' }).click();
    await pop.locator('textarea').fill('Reply from the popover');
    await page.keyboard.press(withMod('Enter'));

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('Reply from the popover');

    // Close and reopen on the same highlight: the reply persists on the card.
    await page.keyboard.press('Escape');
    await expect(pop).not.toBeVisible();
    await page.locator('mark.comment-highlight').first().click();
    await expect(pop).toContainText('Reply from the popover');
  });

  test('creating a comment at a narrow width opens the popover on the new comment automatically', async ({
    page,
  }) => {
    await openFixture(page);

    // No rail at this width: the comment surface is the FAB/drawer, and the
    // popover is what opens automatically on the just-created comment.
    await expect(page.locator('[data-comments-rail]')).toHaveCount(0);

    await addComment(page, 'brute force attacks', 'Auto-opened popover comment');

    const pop = popover(page);
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Auto-opened popover comment');
  });
});

test.describe('Filter auto-widen', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('clicking an open comment highlight while the Resolved filter hides it switches the filter and activates the card', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Auto-widen open comment');
    await addComment(page, 'brute force attacks', 'Auto-widen resolved comment');

    await toggleSetting(page, 'Enable resolve workflow');
    await switchToListDensity(page);

    await clickCardAction(page, 'Auto-widen resolved comment', 'Resolve');

    // Filter to Resolved: the open comment's card leaves the list.
    await page.locator('[data-comments-rail] .flex.gap-1 button', { hasText: 'Resolved' }).click();
    await expect(getCard(page, 'Auto-widen resolved comment')).toBeVisible();
    await expect(getCard(page, 'Auto-widen open comment')).not.toBeVisible();

    // Clicking the open comment's highlight means "show me this comment":
    // the filter widens to include it and its card becomes active.
    await page.locator('mark.comment-highlight', { hasText: 'valid credentials' }).click();

    const openCard = getCard(page, 'Auto-widen open comment');
    await expect(openCard).toBeVisible();
    await expect(openCard).toHaveClass(/border-primary-border/);
  });
});

test.describe('Resolved anchor traces (Anchored density)', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('clicking a resolved trace opens the popover, since Anchored density gives it no card', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Trace open comment');
    await addComment(page, 'brute force attacks', 'Trace resolved comment');

    await resolveComment(page, 'Trace resolved comment');
    await switchToAnchoredDensity(page);

    // The resolved anchor keeps a trace in the prose, and only the open
    // comment gets a margin card. That combination is the whole reason the
    // click needs somewhere else to land.
    await expect(page.locator('mark.comment-highlight-resolved')).toHaveCount(1);
    await expect(page.locator('[data-margin-card-id]')).toHaveCount(1);

    const pop = popover(page);
    await expect(pop).not.toBeVisible();

    await page.locator('mark.comment-highlight-resolved').click();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Trace resolved comment');

    // Clicking an open highlight afterwards must not strand the popover: it
    // would sit there describing a different comment than the active one.
    await page.locator('mark.comment-highlight', { hasText: 'valid credentials' }).click();
    await expect(pop).not.toBeVisible();
  });

  test('a resolved density tick opens the popover, the same as its trace does', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Tick resolved comment');

    await resolveComment(page, 'Tick resolved comment');
    await switchToAnchoredDensity(page);

    const tick = page.locator('[data-density-strip] [data-tick-id]').first();
    await expect(tick).toBeVisible();

    const pop = popover(page);
    await expect(pop).not.toBeVisible();

    // The strip is a click surface of its own, and resolved comments reach it.
    // Activating without deciding where the thread goes leaves the tick dead:
    // Anchored density draws no card for a resolved comment.
    await tick.click();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Tick resolved comment');
  });

  test('reopening from the popover and resolving again does not resurrect it', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Round trip comment');

    await resolveComment(page, 'Round trip comment');
    await switchToAnchoredDensity(page);

    const pop = popover(page);
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(pop).toBeVisible();

    // Reopening gives the comment a margin card, so the rail takes the thread
    // back and the popover goes away.
    await pop.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(pop).not.toBeVisible();
    await expect(page.locator('[data-margin-card-id]')).toHaveCount(1);

    // Resolving again from the card removes the card. Nothing was clicked in
    // the prose, so nothing should open: a popover appearing here is a stale
    // id surviving the round trip.
    await clickCardAction(page, 'Round trip comment', 'Resolve');
    await expect(page.locator('[data-margin-card-id]')).toHaveCount(0);
    await expect(pop).not.toBeVisible();
  });

  test('the trace context menu offers only what a resolved thread can do, and Jump lands', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Menu resolved comment');

    await resolveComment(page, 'Menu resolved comment');
    await switchToAnchoredDensity(page);

    await page.locator('mark.comment-highlight-resolved').click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();

    // Every card surface hides Edit and Reply on a settled thread, so the menu
    // the trace opens must not promise them either.
    await expect(menu.getByText('Edit', { exact: true })).toHaveCount(0);
    await expect(menu.getByText('Reply', { exact: true })).toHaveCount(0);
    await expect(menu.getByText('Reopen', { exact: true })).toBeVisible();

    // Jump to Sidebar has to reach a surface that draws the thread. Revealing
    // the rail is not enough: Anchored density gives a resolved comment no
    // card, so the jump would land on a comment nothing renders.
    await menu.getByText('Jump to Sidebar', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Comments' })).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Comments' }).getByText('Menu resolved comment'),
    ).toBeVisible();
  });

  test('handing the thread to the drawer takes the popover away with it', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Handover comment');

    await resolveComment(page, 'Handover comment');
    await switchToAnchoredDensity(page);

    const pop = popover(page);
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(pop).toBeVisible();

    // Jump to Sidebar reaches the same verdict the click did (Anchored draws
    // no card for a resolved comment) and opens the drawer instead. The
    // popover has to go: it renders under the drawer's overlay showing a
    // second copy of the same thread, and surfaces again when the drawer
    // closes, unrequested.
    await page.locator('mark.comment-highlight-resolved').click({ button: 'right' });
    await page.locator('.context-menu-enter').getByText('Jump to Sidebar', { exact: true }).click();

    const drawer = page.getByRole('dialog', { name: 'Comments' });
    await expect(drawer).toBeVisible();
    await expect(pop).not.toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(pop).not.toBeVisible();
  });

  test('a resolved trace still opens after a raw view round trip', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Round trip comment');

    await resolveComment(page, 'Round trip comment');
    await switchToAnchoredDensity(page);

    const pop = popover(page);
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(pop).toBeVisible();

    // Leave for raw view through the command palette, not the toolbar button.
    // The popover dismisses itself on any document mousedown outside it, so a
    // click on the toolbar clears the id on the way past and hides all of
    // this; the palette route is pure keyboard and leaves the id where it was.
    await page.keyboard.press(withMod('k'));
    const palette = page.getByPlaceholder('Type a command...');
    await expect(palette).toBeVisible();
    await palette.fill('Switch to raw markdown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await expect(pop).not.toBeVisible();

    // Coming back can use the button: the popover is unmounted in raw view,
    // so its outside-click listener is gone and cannot mask anything.
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('mark.comment-highlight-resolved')).toHaveCount(1);
    await expect(pop).not.toBeVisible();

    // The payload assertion. Keying the reset on activeFilePath alone let the
    // id survive into the returning render, where the popover remounts before
    // the page element it measures against exists: its position effect reads a
    // null pageRef, bails, and `pos` never gets set, so the component renders
    // null and the effect's deps never change again. From then on the trace is
    // dead, not noisy: every click assigns the same id, React bails out of the
    // update, and nothing remounts. Clearing on railCapable means the click
    // below mounts a fresh popover against a page that exists.
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Round trip comment');
  });
});

test.describe('Resolved anchor traces (List density)', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('clicking a resolved trace reveals its card even when it is already active', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'List trace comment');

    await resolveComment(page, 'List trace comment');

    // Exact match: the tab bar's "Open file" button also starts with "Open".
    // The tab carries no count badge here, since the only comment is resolved.
    const openFilter = page.getByRole('button', { name: 'Open', exact: true });
    const card = page.locator('[data-comment-card-id]');

    // First click widens the filter because the active comment CHANGES.
    await openFilter.click();
    await expect(card).toHaveCount(0);
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(card).toHaveCount(1);

    // Put the filter back. The comment stays active, so a second click on the
    // trace changes no state at all, so the widen has to be driven by the click
    // itself or this one lands nowhere.
    await openFilter.click();
    await expect(card).toHaveCount(0);
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(card).toHaveCount(1);
  });

  test('a highlight click keeps a search that was not hiding the card', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Search survivor comment');
    await addComment(page, 'brute force attacks', 'Search casualty comment');

    await switchToListDensity(page);

    const search = page.getByPlaceholder('Search');
    await search.fill('survivor');
    await expect(getCard(page, 'Search survivor comment')).toBeVisible();
    await expect(getCard(page, 'Search casualty comment')).not.toBeVisible();

    // Every highlight click sends a focus request now, and the request handler
    // used to clear the search box before asking whether the search was what
    // hid the card. Clicking a comment the search already shows must leave the
    // reviewer's search exactly where it was.
    await page.locator('mark.comment-highlight', { hasText: 'valid credentials' }).click();
    await expect(search).toHaveValue('survivor');
    await expect(getCard(page, 'Search casualty comment')).not.toBeVisible();

    // Clicking one the search DOES hide still widens: the request has to land.
    await page.locator('mark.comment-highlight', { hasText: 'brute force attacks' }).click();
    await expect(search).toHaveValue('');
    await expect(getCard(page, 'Search casualty comment')).toBeVisible();
  });

  test('a highlight click scrolls the card into view without taking focus', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Focus bystander comment');

    await switchToListDensity(page);

    // Routing every highlight click through a focus request put DOM focus on
    // a ThreadCard (tabIndex -1) for a click that was only ever "show me this
    // comment". Focus leaving the document means the next space or PageDown
    // scrolls the rail instead of the prose, Tab starts walking the cards,
    // and a screen reader is lifted out of the passage being read.
    await page.locator('mark.comment-highlight').first().click();

    const card = page.locator('[data-comment-card-id]');
    await expect(card).toHaveCount(1);
    await expect(card).not.toBeFocused();

    // The card is still activated and shown; only the focus move is gone.
    await expect(getCard(page, 'Focus bystander comment')).toBeVisible();

    // And the context menu, which names the card deliberately, still lands on
    // it. The two paths shared one origin before, so this is what stops a fix
    // for the click from quietly disarming the jump.
    await page.locator('mark.comment-highlight').first().click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Jump to Sidebar', { exact: true }).click();
    await expect(card).toBeFocused();
  });

  test('dragging a live anchor does not rewrite a resolved comment sharing it', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Live comment');
    await addComment(page, 'brute force attacks', 'Settled comment');

    await resolveComment(page, 'Settled comment');

    // Both comments sit on the identical span, so they share one mark, and the
    // live one keeps it painted open. Drag-resize rewrites the anchor of every
    // id that mark carries, so a settled id riding along here would have its
    // anchor and context rewritten on disk with nothing on screen to show it.
    const mark = page.locator('mark.comment-highlight');
    await expect(mark).toHaveCount(1);

    await getCard(page, 'Live comment').click();
    const endHandle = page.locator('[data-drag-handle]').last();
    await expect(endHandle).toBeVisible();
    const box = await endHandle.boundingBox();
    // Assert rather than force: boundingBox can return null on a reflow race
    // even right after toBeVisible, and a null deref in the arithmetic below
    // reads as a bug in the drag rather than as a missing handle.
    expect(box).not.toBeNull();
    await endHandle.hover();
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 80, box!.y + box!.height / 2);
    await page.mouse.up();

    // The cards re-parse from the saved file, so they report what landed there.
    const liveAnchor = getCard(page, 'Live comment').locator('[data-anchor-quote]').first();
    await expect(liveAnchor).not.toHaveText(/^["“”]brute force attacks["“”]$/);

    const settledAnchor = getCard(page, 'Settled comment').locator('[data-anchor-quote]').first();
    await expect(settledAnchor).toHaveText(/^["“”]brute force attacks["“”]$/);
  });

  test('a live anchor can be dragged across a resolved trace', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'Rate limiting', 'Draggable comment');
    await addComment(page, 'prevents', 'Trace in the way');

    await resolveComment(page, 'Trace in the way');

    const trace = page.locator('mark.comment-highlight-resolved');
    await expect(trace).toHaveCount(1);

    await getCard(page, 'Draggable comment').click();
    const endHandle = page.locator('[data-drag-handle]').last();
    await expect(endHandle).toBeVisible();

    // Start the gesture BEFORE measuring the trace. Hovering the handle can
    // scroll it into view, which moves every rect on the page; a box read
    // earlier points at whatever slid into those coordinates instead.
    await endHandle.hover();
    await page.mouse.down();
    const traceBox = await trace.boundingBox();
    expect(traceBox).not.toBeNull();

    // Land the pointer in the MIDDLE of the trace and let go there. The guard
    // that refuses to drag into another comment's mark counted the trace as
    // one, so the mousemove returned before the anchor grew and the drag
    // stopped dead against a 1px dotted underline. The midpoint is what makes
    // that deterministic: clearing the trace in one move steps over the guard,
    // and even its right edge resolves to a caret outside the mark.
    await page.mouse.move(traceBox!.x + traceBox!.width / 2, traceBox!.y + traceBox!.height / 2);
    await page.mouse.up();

    // Mid-word by construction. Anchored to the trace's own text rather than
    // to a prefix of it: "Rate limiting p" would also match the runaway
    // whole-paragraph anchor a mis-measured drag produces.
    const anchor = getCard(page, 'Draggable comment').locator('[data-anchor-quote]').first();
    await expect(anchor).toHaveText(/^["\u201c\u201d]Rate limiting pre[a-z]*["\u201c\u201d]$/);

    // The trace's own comment is untouched: this widened one anchor over
    // another, which is what overlapping anchors have always been allowed to do.
    const traceAnchor = getCard(page, 'Trace in the way').locator('[data-anchor-quote]').first();
    await expect(traceAnchor).toHaveText(/^["\u201c\u201d]prevents["\u201c\u201d]$/);
  });

  test('Jump to Sidebar reveals a filtered-out card that is already active', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Jump trace comment');

    await resolveComment(page, 'Jump trace comment');

    const openFilter = page.getByRole('button', { name: 'Open', exact: true });
    const card = page.locator('[data-comment-card-id]');

    // Same trap as the click path, at the entry point the trace also opened:
    // the comment stays active behind the filter, so revealing an already
    // visible rail accomplishes nothing on its own.
    await page.locator('mark.comment-highlight-resolved').click();
    await expect(card).toHaveCount(1);
    await openFilter.click();
    await expect(card).toHaveCount(0);

    await page.locator('mark.comment-highlight-resolved').click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Jump to Sidebar', { exact: true }).click();

    await expect(card).toHaveCount(1);
  });

  test('Jump to Sidebar focuses the card in a rail the same call is opening', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'brute force attacks', 'Reveal and focus comment');

    await resolveComment(page, 'Reveal and focus comment');

    // Hide the rail. The window is still wide enough for it, so the reveal
    // path (rather than the drawer fallback) is what the jump will take.
    await page.keyboard.press(withMod('\\'));
    await expect(page.locator('[data-comments-rail]')).toHaveCount(0);

    await page.locator('mark.comment-highlight-resolved').click({ button: 'right' });
    const menu = page.locator('.context-menu-enter');
    await expect(menu).toBeVisible();
    await menu.getByText('Jump to Sidebar', { exact: true }).click();

    // Routing the focus request through requestListFocus dropped it here:
    // that guard reads railShown, which inside this same call is still the
    // pre-reveal false. The card landed on screen anyway (a hidden rail
    // unmounts and remounts with its filter at All), so only the missing
    // focus tells the two apart.
    const card = page.locator('[data-comment-card-id]');
    await expect(card).toHaveCount(1);
    await expect(card).toBeFocused();
  });
});
