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

  test('a narrow strip moves its controls above the tabs instead of over them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(
      (tabs) => {
        localStorage.setItem(
          'md-redline-session',
          JSON.stringify({ openTabs: tabs, activeFilePath: tabs[1] }),
        );
      },
      OVERFLOW_FIXTURES.slice(0, 3),
    );
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overflow Tab 2' })).toBeVisible({
      timeout: 10_000,
    });

    const tabsRow = page.locator('[data-strip-tabs]');
    const controls = page.locator('[data-strip-controls]');

    // Wide: one row, as before.
    const wideTabs = (await tabsRow.boundingBox())!;
    const wideControls = (await controls.boundingBox())!;
    expect(Math.abs(wideControls.y - wideTabs.y)).toBeLessThan(1);

    // 617px is a narrow window with the Explorer open; 400px leaves the
    // document panel about as narrow as the desktop app allows.
    for (const width of [617, 400]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(async () => {
          const t = (await tabsRow.boundingBox())!;
          const c = (await controls.boundingBox())!;
          return c.y + c.height <= t.y + 0.5;
        })
        .toBe(true);

      // Every control takes its own click: nothing paints over it.
      const covered = await page.evaluate(() =>
        [...document.querySelectorAll('[data-strip-controls] button')]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !(top && b.contains(top));
          })
          .map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title')),
      );
      expect(covered, `covered controls at ${width}px`).toEqual([]);

      // The active tab shows inside the tabs' scrollport, not scrolled away or
      // squeezed to nothing. Polled: the strip scrolls it back into view once
      // the resize settles.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const strip = document.querySelector('[data-doc-strip]')!;
              const port = strip.querySelector('.overflow-x-auto')!.getBoundingClientRect();
              const active = [...strip.querySelectorAll('.overflow-x-auto button')].find((b) =>
                b.textContent?.includes('overflow-tab-2.md'),
              )!;
              const a = active.getBoundingClientRect();
              return Math.min(a.right, port.right) - Math.max(a.left, port.left);
            }),
          { message: `visible active tab at ${width}px` },
        )
        .toBeGreaterThan(60);
    }
  });

  test('a long-named active tab shortens in a narrow strip and grows back when it widens', async ({
    page,
  }) => {
    const longName = resolve(fixtureDir, 'quarterly-planning-notes-with-a-long-name.md');
    writeFileSync(longName, TEST_DOC_BASELINE);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?file=${encodeURIComponent(longName)}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    const tab = strip(page).getByTitle(longName);
    const width = async () => (await tab.boundingBox())!.width;
    // Wide, it takes the tabs' full 200px.
    await expect.poll(width).toBeGreaterThan(195);

    // Narrow, it fits the scrollport and its name ends in an ellipsis.
    await page.setViewportSize({ width: 400, height: 800 });
    await expect.poll(width).toBeLessThan(150);
    const port = (await strip(page).locator('.overflow-x-auto').boundingBox())!;
    expect(await width()).toBeLessThanOrEqual(port.width + 0.5);
    const ellipsized = await tab
      .locator('.truncate')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(ellipsized).toBe(true);

    // Wide again, it is back to full width rather than stuck at the narrow one.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(width).toBeGreaterThan(195);
  });

  test('a wrapped strip lets its tabs reach back over a desktop window inset', async ({ page }) => {
    await page.setViewportSize({ width: 617, height: 800 });
    await page.goto(`/?file=${encodeURIComponent(FIXTURE)}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });
    // What a desktop shell sets to clear its window controls on the top row.
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--window-inset-left', '70px'),
    );

    await expect(strip(page)).toHaveAttribute('data-wrapped', 'true');
    const pageEdge = (await page.locator('[data-doc-page-surface]').boundingBox())!.x;
    const firstTab = strip(page).getByTitle(FIXTURE);
    await expect.poll(async () => (await firstTab.boundingBox())!.x).toBeCloseTo(pageEdge, 0);
    await expect(firstTab).toHaveAttribute('data-tab-flush', '');
  });
});

const band = (page: Page) => page.locator('[data-review-band]');

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

test.describe('Review band and window chrome', () => {
  test('the empty page teaches the command palette and the shortcuts, and both open', async ({
    page,
  }) => {
    await page.goto('/');
    const empty = page.getByTestId('no-file-open');
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await empty.getByRole('button', { name: /Command palette/ }).click();
    const input = page.getByPlaceholder('Type a command...');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);

    await empty.getByRole('button', { name: /Keyboard shortcuts/ }).click();
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  });

  test('the sidebar footer holds only Settings and the author', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('[data-palette-hint]')).toHaveCount(0);
    await page.keyboard.press(withMod('b'));
    await expect(page.locator('[data-sidebar-rail]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Command palette' })).toHaveCount(0);
  });

  test('the window has no status bar', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('footer')).toHaveCount(0);
    await expect(page.locator('[data-status-bar]')).toHaveCount(0);
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

  test("a long file name truncates in its tab, which carries the full path, and the strip's controls stay in the window", async ({
    page,
  }) => {
    const longName = `${'long-file-name-'.repeat(12)}.md`;
    const longPath = resolve(fixtureDir, longName);
    copyFileSync(FIXTURE, longPath);
    await openFixture(page, longPath);

    const tab = strip(page).locator(`button[title="${longPath}"]`);
    await expect(tab).toBeVisible();
    const name = tab.getByText(longName, { exact: true });
    // The name gave way rather than the controls: it is clipped, not wrapped.
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    const handoff = strip(page).getByTestId('handoff-button');
    await expect(handoff).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = (await handoff.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
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
      // page shows as a notice while that tab is active.
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
      await expect(page.locator('[data-page-notices]')).toBeVisible({
        timeout: 5_000,
      });
      await expect(banner.getByRole('button', { name: /awaiting your reply/ })).toBeVisible();

      await page.keyboard.press(withMod('.'));
      const exit = strip(page).locator('[data-focus-chip]');
      await expect(exit).toBeVisible();

      const viewport = page.viewportSize()!;
      for (const el of [exit, banner.locator('[data-row-actions]').first()]) {
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    } finally {
      await abortSession(request, baseURL!, sessionId);
      await abortSession(request, baseURL!, otherId);
    }
  });

  test('exit focus lives at the end of the tab strip and restores a mixed pane state', async ({
    page,
  }) => {
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
    const exit = strip(page).locator('[data-focus-chip]');
    await expect(exit).toBeVisible();
    await expect(page.locator('[data-focus-chip]')).toHaveCount(1);

    await exit.click();
    await expect(exit).toHaveCount(0);
    await expect(explorer).toBeVisible();
    await expect(commentsToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-margin-notes]')).toHaveCount(0);
  });

  test('with the shell inset on the sidebar row, the Explorer and Outline switches drop to icons and fit', async ({
    page,
  }) => {
    await openFixture(page);
    const top = page.locator('[data-sidebar-top]');
    await expect(top).toBeVisible();
    await top.evaluate((el) =>
      (el as HTMLElement).style.setProperty('--window-inset-left', '72px'),
    );
    // Polled: the switches drop to icons once the row's resize observer
    // reports the narrower content box, a frame after the inset lands.
    const fits = () =>
      top.evaluate((el) => {
        const row = el.getBoundingClientRect();
        const close = el.querySelector('[aria-label="Close panel"]')!.getBoundingClientRect();
        const switches = [...el.querySelectorAll('button[title]')].filter(
          (b) => b.getAttribute('aria-label') !== 'Close panel',
        );
        return switches.every((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= row.left && r.right <= close.left;
        });
      });
    await expect.poll(fits).toBe(true);
    // The labels stay as the buttons' accessible names.
    await expect(top.getByRole('button', { name: 'Explorer' })).toBeVisible();
    await expect(top.getByRole('button', { name: 'Outline' })).toBeVisible();
  });

  test('the Explorer and Outline labels never wrap under their icons, and come back when there is room', async ({
    page,
  }) => {
    await openFixture(page);
    const top = page.locator('[data-sidebar-top]');
    // sr-only keeps a 1px box, which Playwright counts as visible.
    const labelWidth = () =>
      top.getByText('Explorer', { exact: true }).evaluate((el) => el.getBoundingClientRect().width);
    const switchHeights = () =>
      top.evaluate((el) =>
        [
          ...el.querySelectorAll('button[title="File explorer"], button[title="Document outline"]'),
        ].map((b) => Math.round(b.getBoundingClientRect().height)),
      );

    // Room for the labels: shown, each on one line beside its icon.
    await expect.poll(labelWidth).toBeGreaterThan(20);
    for (const h of await switchHeights()) expect(h).toBeLessThanOrEqual(30);

    // An inset that leaves too little room: icons only.
    await top.evaluate((el) =>
      (el as HTMLElement).style.setProperty('--window-inset-left', '72px'),
    );
    await expect.poll(labelWidth).toBeLessThan(2);
    for (const h of await switchHeights()) expect(h).toBeLessThanOrEqual(30);

    // The inset goes away: the labels come back.
    await top.evaluate((el) => (el as HTMLElement).style.removeProperty('--window-inset-left'));
    await expect.poll(labelWidth).toBeGreaterThan(20);
    for (const h of await switchHeights()) expect(h).toBeLessThanOrEqual(30);
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
    await expect(strip(page).locator('[data-focus-chip]')).toBeVisible();
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

  test('Escape closes Settings first when it opened over the View menu', async ({ page }) => {
    await openFixture(page);
    await strip(page).getByRole('button', { name: 'View options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press(withMod(','));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
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

  test("stays during an agent's review, which has no send of its own", async ({
    page,
    request,
    baseURL,
  }) => {
    writeFileSync(FIXTURE, COMMENTED_DOC);
    const res = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [FIXTURE], enableResolve: false, origin: 'agent' },
    });
    expect(res.status()).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      await expect(band(page).getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
      await page.locator('.prose').waitFor({ timeout: 10_000 });
      await expect(strip(page).getByTestId('handoff-button')).toBeVisible();
    } finally {
      await abortSession(request, baseURL!, sessionId);
    }
  });
});

test.describe('Settings, empty rail and desktop shell hooks', () => {
  test('Settings links to the keyboard shortcuts', async ({ page }) => {
    await openFixture(page);
    await page
      .locator('[data-sidebar-panel]')
      .getByTitle(/^Settings/)
      .click();
    await page.getByTestId('settings-open-shortcuts').click();
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  });

  test('same-named tabs show the folder that tells them apart', async ({ page }) => {
    const dir = resolve(fixtureDir, 'twin-dir');
    mkdirSync(dir, { recursive: true });
    const twin = resolve(dir, 'test-doc.md');
    copyFileSync(FIXTURE, twin);
    await openFixture(page);
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(twin);
    await page.getByPlaceholder('File path or name...').press('Enter');
    await expect(strip(page).locator('[data-tab-folder]')).toHaveCount(2);
    await expect(strip(page).locator(`button[title="${twin}"] [data-tab-folder]`)).toHaveText(
      'twin-dir',
    );
  });

  test('deep same-named tabs keep their whole file names, labelled by the folder that differs', async ({
    page,
  }) => {
    const shared = ['specs', 'docs'];
    const twins = ['north-project-workspace', 'south-project-workspace'].map((top) => {
      const dir = resolve(fixtureDir, top, ...shared);
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, 'test-doc.md');
      copyFileSync(FIXTURE, file);
      return file;
    });
    await page.goto(`/?file=${encodeURIComponent(twins[0])}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(twins[1]);
    await page.getByPlaceholder('File path or name...').press('Enter');

    const labels = strip(page).locator('[data-tab-folder]');
    await expect(labels).toHaveCount(2);
    const texts = await labels.allTextContents();
    // Long names that share a suffix: shortened, but never to the same text.
    expect(new Set(texts).size).toBe(2);
    expect(texts.every((t) => t.startsWith('north') || t.startsWith('south'))).toBe(true);
    for (const file of twins) {
      const name = strip(page).locator(`button[title="${file}"] .truncate`).first();
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
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

  test('neither sidebar state has a logo; the rail lines its first icon up with the tabs', async ({
    page,
  }) => {
    await openFixture(page);
    await expect(page.locator('[data-sidebar-panel]')).toBeVisible();
    // Explorer and Outline sit in the panel's top row, beside close.
    const top = page.locator('[data-sidebar-top]');
    await expect(top.getByRole('button', { name: /Explorer/ })).toBeVisible();
    await expect(top.getByRole('button', { name: 'Close panel' })).toBeVisible();

    await page.keyboard.press(withMod('b'));
    const rail = page.locator('[data-sidebar-rail]');
    await expect(rail).toBeVisible();
    await expect(rail.locator('svg[viewBox="0 0 100 116"]')).toHaveCount(0);
    const center = (loc: ReturnType<typeof page.locator>) =>
      loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      });
    const firstIcon = rail.getByRole('button').first();
    const activeTab = strip(page).locator('button.group').first();
    expect(Math.abs((await center(firstIcon)) - (await center(activeTab)))).toBeLessThanOrEqual(2);
  });

  test('? still opens the keyboard shortcuts panel', async ({ page }) => {
    await openFixture(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  });
});
