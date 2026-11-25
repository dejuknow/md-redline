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
    await expect(page.locator('[data-diff-bar-toggle]')).toHaveAttribute('aria-pressed', 'true');
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

    // Diff on, from the diff bar that the changes brought up.
    await page.locator('[data-diff-bar-toggle]').click();
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

const band = (page: Page) => page.locator('[data-review-band]');
const statusBar = (page: Page) => page.locator('[data-status-bar]');

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

test.describe('Review band and status bar', () => {
  test('the Commands hint opens the command palette', async ({ page }) => {
    await openFixture(page);
    await statusBar(page).getByRole('button', { name: 'Command palette' }).click();
    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('select text, click the Commands hint: "Copy selection as markdown" is offered and copies that selection', async ({
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

    await statusBar(page).getByRole('button', { name: 'Command palette' }).click();
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
    await expect(strip(page).getByTestId('handoff-button')).toBeVisible();
    await expect(band(page)).toHaveCount(0);

    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = band(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId('handoff-button')).toHaveCount(0);

      await banner.getByRole('button', { name: 'Cancel review' }).click();
      await expect(page.getByTestId('review-banner')).toHaveCount(0, { timeout: 8_000 });
      await expect(band(page)).toHaveCount(0);
      await expect(strip(page).getByTestId('handoff-button')).toBeVisible();
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });

  test('a long file path truncates in the status bar and its hints stay in the window', async ({
    page,
  }) => {
    const longName = `${'long-file-name-'.repeat(12)}.md`;
    const longPath = resolve(fixtureDir, longName);
    copyFileSync(FIXTURE, longPath);
    await openFixture(page, longPath);

    const path = statusBar(page).locator('[data-status-path]');
    await expect(path).toBeVisible();
    await expect(path).toHaveAttribute('title', /long-file-name-/);
    const chip = statusBar(page).getByRole('button', { name: 'Command palette' });
    await expect(chip).toBeVisible();
    await expect(strip(page).getByTestId('handoff-button')).toBeVisible();

    const viewport = page.viewportSize()!;
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(viewport.width);
    const pathBox = (await path.boundingBox())!;
    expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(chipBox.x);
    // The path gave way rather than the hints: it is clipped, not wrapped.
    expect(await path.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });

  test('with no review the document panel lines up with the sidebar; a review docks its band along the bottom of the page', async ({
    page,
    request,
    baseURL,
  }) => {
    await openFixture(page);
    const top = (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    expect(await top('[data-doc-panel]')).toBe(await top('[data-sidebar-panel]'));
    const stripTop = await top('[data-doc-strip]');

    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      await expect(band(page).getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
      expect(await top('[data-doc-panel]')).toBe(await top('[data-sidebar-panel]'));
      // The band is docked along the page's bottom edge, inside the page card,
      // so the tabs do not move when a review starts.
      expect(await top('[data-doc-strip]')).toBe(stripTop);
      await expect(page.locator('[data-doc-page-surface] > [data-review-band]')).toHaveCount(1);
      const bottom = (sel: string) =>
        page
          .locator(sel)
          .first()
          .evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
      // Polled: the band slides up as it mounts.
      const surfaceBottom = await bottom('[data-doc-page-surface]');
      await expect.poll(() => bottom('[data-review-band]')).toBe(surfaceBottom - 1);
      // A user review waits on the reader, so the band is emphasized, and the
      // review's tab is marked up top.
      await expect(band(page)).toHaveAttribute('data-review-band-emphasis');
      await expect(page.locator('[data-tab-in-review]')).toHaveCount(1);
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });

  test("at a 760px window a user review's Send N & finish is reachable through More review actions", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    writeFileSync(FIXTURE, COMMENTED_DOC);
    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = band(page).getByTestId('review-banner');
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

  test('focus mode at a 1200px window with a question and a long error keeps Exit focus and the review actions in the window', async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    writeFileSync(FIXTURE, COMMENTED_DOC);
    // Two reviews of the open file: the band shows one and a "+1" for the other.
    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    const otherRes = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [FIXTURE, OVERFLOW_FIXTURES[0]], enableResolve: false },
    });
    expect(otherRes.status()).toBe(201);
    const otherId = ((await otherRes.json()) as { sessionId: string }).sessionId;
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = band(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      await page.waitForTimeout(500);
      const ask = await request.post(`${baseURL}/api/review-sessions/${sessionId}/agent-comments`, {
        data: {
          questions: [{ filePath: FIXTURE, anchor: 'authentication system', text: 'Which one?' }],
        },
      });
      expect(ask.status()).toBe(201);
      await expect(banner.getByRole('button', { name: /awaiting your reply/ })).toBeVisible({
        timeout: 10_000,
      });

      // A second file that fails to load with a long message, which the
      // status bar shows as a notice while that tab is active.
      const broken = OVERFLOW_FIXTURES[1];
      const longError = `Failed to load file: ${'the disk refused the read again '.repeat(8)}`;
      await page.route(
        (url) => url.pathname === '/api/file' && url.searchParams.get('path') === broken,
        (route) =>
          route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: longError }),
          }),
      );
      await page.locator('button[title="Open file"]').click();
      await page.getByPlaceholder('File path or name...').fill(broken);
      await page.getByPlaceholder('File path or name...').press('Enter');
      await expect(statusBar(page).locator('[data-status-notices]')).toBeVisible({
        timeout: 5_000,
      });
      await expect(banner.getByRole('button', { name: /awaiting your reply/ })).toBeVisible();

      await page.keyboard.press(withMod('.'));
      const exit = statusBar(page).locator('[data-focus-chip]');
      await expect(exit).toBeVisible();

      const viewport = page.viewportSize()!;
      for (const el of [
        statusBar(page).getByRole('button', { name: 'Command palette' }),
        exit,
        banner.locator('[data-row-actions]').first(),
      ]) {
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    } finally {
      await abortSession(request, baseURL!, sessionId);
      await abortSession(request, baseURL!, otherId);
    }
  });

  test('exit focus lives in the status bar and restores a mixed pane state', async ({ page }) => {
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
    const exit = statusBar(page).locator('[data-focus-chip]');
    await expect(exit).toBeVisible();
    await expect(page.locator('[data-focus-chip]')).toHaveCount(1);

    await exit.click();
    await expect(exit).toHaveCount(0);
    await expect(explorer).toBeVisible();
    await expect(commentsToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-margin-notes]')).toHaveCount(0);
  });

  test('shell inset shifts the strip in every sidebar state', async ({ page }) => {
    await openFixture(page);
    const firstChildOffset = () =>
      strip(page).evaluate((el) => {
        // Set on every check: a desktop shell sets it once, and this is that,
        // re-applied in case a state change rebuilt the node.
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
    await expect(statusBar(page).locator('[data-focus-chip]')).toBeVisible();
    expect(await firstChildOffset()).toBeGreaterThanOrEqual(72);
  });
});

/** A painted mouse selection over the paragraph that holds `text`. */
async function paintSelection(page: Page, text: string) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.prose p')].find((p) => p.textContent?.includes(t));
    if (!el) throw new Error('paragraph not found');
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, text);
  await expect(page.locator('mark.selection-highlight').first()).toBeVisible({ timeout: 5000 });
}

test.describe('Menus, Escape and copy', () => {
  test('with the View menu open, ⌘K then one Escape closes the palette', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await openFixture(page);
    await strip(page).getByRole('button', { name: 'View options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();

    await page.keyboard.press(withMod('k'));
    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();
    // The palette took the focus, so the menu let go.
    await expect(page.getByRole('menu')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
  });

  test('Escape on an open strip or band menu closes it and keeps the painted selection', async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    writeFileSync(FIXTURE, COMMENTED_DOC);
    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = band(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      await page.locator('.prose').waitFor({ timeout: 10_000 });
      await paintSelection(page, 'authentication system');
      const painted = page.locator('mark.selection-highlight');

      // Opened from the keyboard: a press outside the document drops the
      // selection by design, which is not what this pins.
      await strip(page).getByRole('button', { name: 'View options' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(painted.first()).toBeVisible();

      await banner.getByRole('button', { name: 'More review actions' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu', { name: 'More review actions' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(painted.first()).toBeVisible();
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });

  test('Copy document from the View menu says it copied, or that it could not', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 800, height: 800 });
    await openFixture(page);
    const copy = () =>
      page.getByRole('menuitem', { name: 'Copy document without comment markers' }).click();

    await strip(page).getByRole('button', { name: 'View options' }).click();
    await copy();
    await expect(page.getByText('Copied the document without comment markers.')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('# Test Document');

    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await strip(page).getByRole('button', { name: 'View options' }).click();
    await copy();
    await expect(page.getByText("Couldn't copy the document.")).toBeVisible();
  });
});

test.describe('Hand off beside a review', () => {
  test('hides only while the active file is in the review', async ({ page, request, baseURL }) => {
    writeFileSync(FIXTURE, COMMENTED_DOC);
    const sessionId = await createUserSession(request, baseURL!, FIXTURE);
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      const banner = band(page).getByTestId('review-banner');
      await expect(banner).toBeVisible({ timeout: 12_000 });
      await page.locator('.prose').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('handoff-button')).toHaveCount(0);

      // Another file, in no review: the review stays, and Hand off is back for it.
      const other = OVERFLOW_FIXTURES[0];
      await page.locator('button[title="Open file"]').click();
      await page.getByPlaceholder('File path or name...').fill(other);
      await page.getByPlaceholder('File path or name...').press('Enter');
      await expect(page.getByRole('heading', { name: 'Overflow Tab 1' })).toBeVisible();
      await expect(banner).toBeVisible();
      await expect(strip(page).getByTestId('handoff-button')).toBeVisible();

      // Back on the reviewed file, the review's own actions replace it.
      await page.locator(`[data-doc-strip] button.group[title="${FIXTURE}"]`).click();
      await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible();
      await expect(page.getByTestId('handoff-button')).toHaveCount(0);
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });
});

test.describe('Status bar, empty rail and desktop shell hooks', () => {
  test('the status bar shows the file path, Commands and Shortcuts', async ({ page }) => {
    await openFixture(page);
    await expect(statusBar(page).locator('[data-status-path]')).toContainText('test-doc.md');
    await statusBar(page).getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  });

  test('with no comments in Anchored, the comments toggle brings up a "No comments yet" note', async ({
    page,
  }) => {
    await openFixture(page);
    const toggle = strip(page).getByRole('button', { name: /Toggle comments rail/ });
    await expect(page.locator('[data-rail-empty]')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(page.locator('[data-rail-empty]')).toContainText('No comments yet');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(page.locator('[data-rail-empty]')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // The first comment replaces the note with its card.
    await toggle.click();
    await addComment(page, 'valid credentials', 'First note');
    await expect(page.locator('[data-rail-empty]')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('many tabs shrink before the strip scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate((tabs) => {
      localStorage.setItem(
        'md-redline-session',
        JSON.stringify({ openTabs: tabs.slice(0, 5), activeFilePath: tabs[0] }),
      );
    }, OVERFLOW_FIXTURES);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overflow Tab 1' })).toBeVisible({
      timeout: 10_000,
    });
    // Five tabs fit beside the controls at this width, so nothing scrolls.
    await expect(page.locator('button[title="Scroll tabs right"]')).toHaveCount(0);
    const widths = await strip(page)
      .locator('.overflow-x-auto button.group')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(widths).toHaveLength(5);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(112);
  });

  test('the open sidebar has no logo; the collapsed rail keeps it as data-sidebar-logo', async ({
    page,
  }) => {
    await openFixture(page);
    await expect(page.locator('[data-sidebar-panel]')).toBeVisible();
    await expect(page.locator('[data-sidebar-logo]')).toHaveCount(0);
    // Explorer and Outline sit in the panel's top row, beside close.
    const top = page.locator('[data-sidebar-top]');
    await expect(top.getByRole('button', { name: /Explorer/ })).toBeVisible();
    await expect(top.getByRole('button', { name: 'Close panel' })).toBeVisible();

    await page.keyboard.press(withMod('b'));
    await expect(page.locator('[data-sidebar-rail]')).toBeVisible();
    await expect(page.locator('[data-sidebar-logo]')).toHaveCount(1);
    await expect(page.locator('[data-sidebar-logo]')).toBeVisible();
  });

  test('? still opens the keyboard shortcuts panel', async ({ page }) => {
    await openFixture(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  });
});
