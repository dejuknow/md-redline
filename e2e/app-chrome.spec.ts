import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { withMod } from './helpers/shortcuts';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_ROOT = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let FIXTURE = '';
let OVERFLOW_FIXTURES: string[] = [];

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_ROOT, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_ROOT,
    `app-chrome-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  FIXTURE = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  OVERFLOW_FIXTURES = Array.from({ length: 8 }, (_, index) => {
    const path = resolve(fixtureDir, `overflow-tab-${index + 1}.md`);
    writeFileSync(
      path,
      TEST_DOC_BASELINE.replace('# Test Document', `# Overflow Tab ${index + 1}`),
    );
    return path;
  });
  await resetTestAppState(page);
});

test.afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

const strip = (page: Page) => page.locator('[data-doc-strip]');

test.describe('Document panel strip', () => {
  test('raw view with changes keeps the diff bar and a way back to rendered', async ({
    page,
    context,
  }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    // A handoff takes the snapshot the diff compares against.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await addComment(page, 'Section One', 'placeholder');
    await page.getByTestId('handoff-button').click();
    await expect(page.getByText(/tracking changes/i)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    // An outside edit after the snapshot gives the diff something to show.
    const current = readFileSync(FIXTURE, 'utf-8');
    writeFileSync(FIXTURE, current.replace('## Section Two', '## Updated Section Two'));
    await expect(page.getByRole('heading', { name: 'Updated Section Two' })).toBeVisible({
      timeout: 15_000,
    });

    await strip(page).locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view')).toBeVisible();

    // Entering raw with changes turns the overlay on by itself: no toggle click.
    await expect(strip(page).locator('button[title="Hide diff"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-diff-bar]')).toBeVisible();
    await expect(page.getByTestId('diff-reference-label')).toBeVisible();

    const back = strip(page).locator('button[title="Switch to rendered view"]');
    await expect(back).toBeEnabled();
    await back.click();
    await expect(page.locator('.raw-view')).not.toBeVisible();
    await expect(page.locator('.prose')).toBeVisible();
  });

  test('the find bar sits below the diff bar in an 800px window, clear of Mark reviewed', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await addComment(page, 'Section One', 'placeholder');
    await page.getByTestId('handoff-button').click();
    await expect(page.getByText(/tracking changes/i)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    const current = readFileSync(FIXTURE, 'utf-8');
    writeFileSync(FIXTURE, current.replace('## Section Two', '## Updated Section Two'));
    await expect(page.getByRole('heading', { name: 'Updated Section Two' })).toBeVisible({
      timeout: 15_000,
    });

    // Diff on, through the View menu when the strip is narrow.
    const viewMenu = strip(page).getByRole('button', { name: 'View options' });
    if (await viewMenu.isVisible()) await viewMenu.click();
    await page.locator('button[title="Show diff"]').click();
    const diffBar = page.locator('[data-diff-bar]');
    const markReviewed = diffBar.getByRole('button', { name: 'Mark reviewed' });
    await expect(markReviewed).toBeVisible();

    await page.keyboard.press(withMod('f'));
    const searchBar = page.locator('[data-testid="search-bar"]');
    await expect(searchBar).toBeVisible();

    const barBox = (await diffBar.boundingBox())!;
    const findBox = (await searchBar.boundingBox())!;
    expect(findBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);

    // And the button takes the click: nothing is painted over it.
    await markReviewed.click({ trial: true });
    const hit = await markReviewed.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit).toBe(true);
  });

  test('selecting an overflow tab from the tab list works in a 720px window', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.evaluate((tabs) => {
      localStorage.setItem(
        'md-redline-session',
        JSON.stringify({ openTabs: tabs, activeFilePath: tabs[tabs.length - 1] }),
      );
    }, OVERFLOW_FIXTURES);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overflow Tab 8' })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('tab-list-button').click();
    const menu = page.getByTestId('tab-list-menu');
    await expect(menu).toBeVisible();

    // Not clipped: the whole 288px menu sits inside the window, and its first
    // entry is what is actually on top at its own center.
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(288);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(720);
    const first = menu.locator('button', { hasText: 'overflow-tab-1.md' });
    const onTop = await first.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit != null && el.contains(hit);
    });
    expect(onTop).toBe(true);

    await first.click();
    await expect(page.getByRole('heading', { name: 'Overflow Tab 1' })).toBeVisible();
    await expect(menu).not.toBeVisible();
  });
});

const header = (page: Page) => page.locator('[data-app-header]');

async function openFixture(page: Page, path = FIXTURE) {
  await page.goto(`/?file=${encodeURIComponent(path)}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

/** A reviewer-origin session on `path`, like the one `mdr_request_review` opens. */
async function createUserSession(
  request: APIRequestContext,
  baseURL: string,
  path: string,
): Promise<string> {
  const res = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: [path], enableResolve: false },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function abortSession(request: APIRequestContext, baseURL: string, id: string) {
  await request.post(`${baseURL}/api/review-sessions/${id}/abort`, {
    headers: { 'content-type': 'application/json' },
  });
}

const COMMENTED_DOC = TEST_DOC_BASELINE.replace(
  'valid credentials',
  '<!-- @comment{"id":"hdr-c1","anchor":"valid credentials","text":"A note","author":"Seth","timestamp":"2026-09-28T00:00:00.000Z"} -->valid credentials',
);

test.describe('App header', () => {
  test('⌘K chip opens the command palette', async ({ page }) => {
    await openFixture(page);
    await header(page).getByRole('button', { name: 'Command palette' }).click();
    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('select text, click the ⌘K chip: "Copy selection as markdown" is offered and copies that selection', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    // A mouse selection, committed and painted, the way a drag leaves one.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.prose p')].find((p) =>
        p.textContent?.includes('authentication system'),
      );
      if (!el) throw new Error('paragraph not found');
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });

    await header(page).getByRole('button', { name: 'Command palette' }).click();
    await page.getByPlaceholder('Type a command...').fill('copy selection');
    await page
      .locator('button[data-selected]', { hasText: 'Copy selection as markdown' })
      .click({ timeout: 5000 });

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(
        'The authentication system supports email and password login. Users must provide valid credentials to access the application. The system validates all inputs before processing.',
      );
  });

  test('hand off is hidden during a review and back after it ends', async ({
    page,
    request,
    baseURL,
  }) => {
    await openFixture(page);
    await expect(header(page).getByTestId('handoff-button')).toBeVisible();

    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = header(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId('handoff-button')).toHaveCount(0);

      await banner.getByRole('button', { name: 'Cancel review' }).click();
      await expect(page.getByTestId('review-banner')).toHaveCount(0, { timeout: 8_000 });
      await expect(header(page).getByTestId('handoff-button')).toBeVisible();
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });

  test('long file name keeps header actions visible', async ({ page }) => {
    const longName = `${'long-file-name-'.repeat(12)}.md`;
    expect(longName.length).toBe(183);
    const longPath = resolve(fixtureDir, longName);
    copyFileSync(FIXTURE, longPath);
    await openFixture(page, longPath);

    const name = header(page).getByText(longName);
    await expect(name).toBeVisible();
    const chip = header(page).getByRole('button', { name: 'Command palette' });
    await expect(chip).toBeVisible();
    await expect(header(page).getByTestId('handoff-button')).toBeVisible();

    const viewport = page.viewportSize()!;
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.x).toBeGreaterThanOrEqual(0);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(viewport.width);
    const statusBox = (await header(page).locator('[data-header-status]').boundingBox())!;
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(chipBox.x);
    // The name gave way rather than the actions: it is clipped, not wrapped.
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
  });

  test("at an 800px window a user review's Send N & finish is reachable through More review actions", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    writeFileSync(FIXTURE, COMMENTED_DOC);
    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = header(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      // The primary stays in the row; the rest fold into the menu.
      await expect(banner.getByRole('button', { name: 'Send 1 comment' })).toBeEnabled({
        timeout: 10_000,
      });
      await expect(banner.getByRole('button', { name: /& finish/ })).toHaveCount(0);

      const waitPromise = request.get(`${baseURL}/api/review-sessions/${sessionId}/wait`);
      await banner.getByRole('button', { name: 'More review actions' }).click();
      await page.getByRole('menuitem', { name: 'Send 1 & finish' }).click();
      const waitRes = await waitPromise;
      expect(((await waitRes.json()) as { status: string }).status).toBe('done');
      await expect(page.getByTestId('review-banner')).toHaveCount(0, { timeout: 8_000 });
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });

  test('exit focus lives in the header and restores a mixed pane state', async ({ page }) => {
    // Explorer open, comments rail hidden: not the default pair, so a restore
    // that falls back to defaults would show the rail.
    await page.evaluate(() =>
      localStorage.setItem(
        'md-redline-pane-layout',
        JSON.stringify({ explorerVisible: true, sidebarVisible: false, leftPanelView: 'explorer' }),
      ),
    );
    writeFileSync(FIXTURE, COMMENTED_DOC);
    await openFixture(page);
    const explorer = page.locator('[data-sidebar-panel]');
    const commentsToggle = strip(page).getByRole('button', { name: /Toggle comments rail/ });
    await expect(explorer).toBeVisible();
    await expect(commentsToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-margin-notes]')).toHaveCount(0);

    await page.keyboard.press(withMod('.'));
    await expect(explorer).toHaveCount(0);
    await expect(page.locator('[data-sidebar-rail]')).toHaveCount(0);
    const exit = header(page).locator('[data-focus-chip]');
    await expect(exit).toBeVisible();
    await expect(page.locator('[data-focus-chip]')).toHaveCount(1);

    await exit.click();
    await expect(exit).toHaveCount(0);
    await expect(explorer).toBeVisible();
    await expect(commentsToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-margin-notes]')).toHaveCount(0);
  });

  test('shell inset shifts the header in every sidebar state', async ({ page }) => {
    await openFixture(page);
    const firstChildOffset = () =>
      header(page).evaluate((el) => {
        // Set on every check: a desktop shell sets it once on the header, and
        // this is that, re-applied in case a state change rebuilt the node.
        (el as HTMLElement).style.setProperty('--window-inset-left', '72px');
        const first = el.firstElementChild!;
        return first.getBoundingClientRect().left - el.getBoundingClientRect().left;
      });

    // Sidebar open.
    await expect(page.locator('[data-sidebar-panel]')).toBeVisible();
    expect(await firstChildOffset()).toBeGreaterThanOrEqual(72);

    // Collapsed to the icon rail.
    await page.keyboard.press(withMod('b'));
    await expect(page.locator('[data-sidebar-rail]')).toBeVisible();
    expect(await firstChildOffset()).toBeGreaterThanOrEqual(72);

    // Focus mode: no sidebar at all.
    await page.keyboard.press(withMod('.'));
    await expect(header(page).locator('[data-focus-chip]')).toBeVisible();
    expect(await firstChildOffset()).toBeGreaterThanOrEqual(72);
  });
});
