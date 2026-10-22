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

test.use({ viewport: { width: 1700, height: 950 } });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `doc-sheet-transition-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // Records every width transition the sheet or its prose column starts.
  // transitionrun fires exactly when the browser starts one, so it counts the
  // animation itself rather than inferring it from sampled widths.
  await page.addInitScript(() => {
    const runs: string[] = [];
    (window as unknown as { __widthRuns: string[] }).__widthRuns = runs;
    document.addEventListener('transitionrun', (e) => {
      const el = e.target as HTMLElement;
      if (e.propertyName !== 'width') return;
      if (el.hasAttribute('data-doc-page')) runs.push('page');
      else if (el.hasAttribute('data-prose-column')) runs.push('column');
    });
  });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function widthRuns(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __widthRuns: string[] }).__widthRuns);
}

test('opening a document does not animate the sheet open from a placeholder width', async ({
  page,
}) => {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  // Longer than the 150ms transition, so one that started would have been seen.
  await page.waitForTimeout(400);
  expect(await widthRuns(page)).toEqual([]);
});

test('reopening a commented document does not animate the rail gutter open', async ({ page }) => {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await addComment(page, 'valid credentials', 'A margin note');
  await expect(page.locator('.margin-note-pos')).toHaveCount(1);
  // Adding the first comment while reading is a change the reader made, so the
  // gutter opening still animates.
  await expect.poll(() => widthRuns(page)).toContain('page');
  await expect.poll(() => readFileSync(fixturePath, 'utf8')).toContain('A margin note');
  // The comment arrives with the file's content, after the sheet has already
  // measured the empty page, and reserves the rail's gutter. A reload would
  // open nothing: the app drops ?file= from the URL once it has opened it.
  await page.goto(`/?file=${fixturePath}`);
  await page
    .locator('[data-doc-page] mark')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(await widthRuns(page)).toEqual([]);
});

test('opening a commented document shows the sheet only where it ends up', async ({ page }) => {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await addComment(page, 'valid credentials', 'A margin note');
  await expect.poll(() => readFileSync(fixturePath, 'utf8')).toContain('A margin note');
  // One entry per painted frame in which the sheet is visible and its box
  // differs from the frame before.
  await page.addInitScript(() => {
    const boxes: string[] = [];
    (window as unknown as { __sheetBoxes: string[] }).__sheetBoxes = boxes;
    const tick = () => {
      const sheet = document.querySelector('[data-doc-page]');
      if (sheet && getComputedStyle(sheet).visibility === 'visible') {
        const r = sheet.getBoundingClientRect();
        const box = `${Math.round(r.left)},${Math.round(r.width)}`;
        if (boxes[boxes.length - 1] !== box) boxes.push(box);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`/?file=${fixturePath}`);
  await page
    .locator('[data-doc-page] mark')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });
  await page.waitForTimeout(400);
  const boxes = await page.evaluate(
    () => (window as unknown as { __sheetBoxes: string[] }).__sheetBoxes,
  );
  expect(boxes).toHaveLength(1);
});

test('a resize after the document opens still animates the sheet', async ({ page }) => {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const sheet = page.locator('[data-doc-page]');
  const before = await sheet.evaluate((el) => el.style.width);
  await page.evaluate(() => {
    (window as unknown as { __widthRuns: string[] }).__widthRuns.length = 0;
  });
  // Narrow enough to squeeze the column below its cap; at wider sizes a
  // comment-free sheet keeps the same width and nothing should animate.
  await page.setViewportSize({ width: 700, height: 950 });
  await expect.poll(() => sheet.evaluate((el) => el.style.width)).not.toBe(before);
  await expect.poll(() => widthRuns(page)).toContain('page');
});

test('reloading a review lays the main column out once, at its final place', async ({
  page,
  request,
  baseURL,
}) => {
  // Three start-up inputs that each move the layout: a non-default Document
  // width, a review banner above the chrome row, and a comment that reserves
  // the rail's gutter.
  const prefsFile = resolve(__dirname, '..', '.playwright-home', '.md-redline.json');
  writeFileSync(
    prefsFile,
    JSON.stringify({ settings: { enableResolve: false, docWidth: 'wide' } }),
  );
  const marker =
    '<!-- @comment{"id":"c1","anchor":"valid credentials","text":"A note","author":"Seth","timestamp":"2026-09-28T00:00:00.000Z"} -->';
  writeFileSync(
    fixturePath,
    TEST_DOC_BASELINE.replace('valid credentials', marker + 'valid credentials'),
  );
  const create = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: [fixturePath], origin: 'agent' },
  });
  const { sessionId } = (await create.json()) as { sessionId: string };
  try {
    // One entry per painted frame in which the main column is visible and
    // the rows in it, or the sheet, sit somewhere other than the frame before.
    await page.addInitScript(() => {
      const layouts: string[] = [];
      (window as unknown as { __layouts: string[] }).__layouts = layouts;
      const tick = () => {
        const sheet = document.querySelector('[data-doc-page]');
        const main = sheet?.closest('.flex-1.min-w-0.flex.flex-col');
        if (sheet && main && getComputedStyle(main).visibility === 'visible') {
          const rows = [...main.children].map((c) => {
            const r = c.getBoundingClientRect();
            return `${Math.round(r.top)}+${Math.round(r.height)}`;
          });
          const r = sheet.getBoundingClientRect();
          const layout = `${rows.join('/')} sheet ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
          if (layouts[layouts.length - 1] !== layout) layouts.push(layout);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 10_000 });
      await page.locator('[data-doc-page] mark').first().waitFor({ state: 'attached' });
      await page.waitForTimeout(400);
      const layouts = await page.evaluate(
        () => (window as unknown as { __layouts: string[] }).__layouts,
      );
      expect(layouts, `reload ${i}`).toHaveLength(1);
    }
  } finally {
    await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  }
});

test('reloading a review lists only its own folder in the explorer, once the page is shown', async ({
  page,
  request,
  baseURL,
}) => {
  // The explorer's folder is decided at start-up from the review's first file.
  // Browsing before that lists the server's working directory -- this repo,
  // with its e2e/ folder -- and swaps it out when the review arrives.
  const create = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: [fixturePath], origin: 'agent' },
  });
  const { sessionId } = (await create.json()) as { sessionId: string };
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        'md-redline-pane-layout',
        JSON.stringify({ explorerVisible: true, leftPanelView: 'explorer' }),
      );
      const seen = { cwdListing: false, beforeReveal: [] as string[] };
      (window as unknown as { __explorer: typeof seen }).__explorer = seen;
      // Any insertion counts, painted or not, so this does not depend on
      // frame timing.
      new MutationObserver(() => {
        const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
        if (labels.includes('e2e')) seen.cwdListing = true;
      }).observe(document, { childList: true, subtree: true });
      const tick = () => {
        const main = document
          .querySelector('[data-doc-page]')
          ?.closest('.flex-1.min-w-0.flex.flex-col');
        const mainShown = main && getComputedStyle(main).visibility === 'visible';
        if (!mainShown) {
          // Text nodes, not elements: the explorer's file row is a button
          // holding an icon and a span, so no leaf element carries its name.
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent?.trim() ?? '';
            const el = node.parentElement;
            if (
              (text === 'Loading...' || text === 'test-doc.md') &&
              el &&
              getComputedStyle(el).visibility === 'visible' &&
              !seen.beforeReveal.includes(text)
            ) {
              seen.beforeReveal.push(text);
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'test-doc.md' }).first()).toBeVisible();
      await page.waitForTimeout(400);
      const seen = await page.evaluate(
        () =>
          (window as unknown as { __explorer: { cwdListing: boolean; beforeReveal: string[] } })
            .__explorer,
      );
      expect(seen, `reload ${i}`).toEqual({ cwdListing: false, beforeReveal: [] });
    }
  } finally {
    await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  }
});

test('an overlay opened during start-up is shown and takes typing', async ({ page }) => {
  // The main column stays hidden while start-up settles, and the command
  // palette, like every other overlay, renders inside it. Holding settings
  // back keeps the page in that window for most of the reveal cap.
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('[data-doc-page]').waitFor({ state: 'attached', timeout: 10_000 });
  const mainVisibility = await page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector('[data-doc-page]')!.closest('.flex-1.min-w-0.flex.flex-col')!,
      ).visibility,
  );
  expect(mainVisibility, 'still starting up').toBe('hidden');

  await page.keyboard.press(withMod('k'));
  const input = page.getByPlaceholder('Type a command...');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.type('reload');
  await expect(input).toHaveValue('reload');
});

test('a review opened in a new tab is shown once its document has loaded', async ({
  page,
  request,
  baseURL,
}) => {
  // The review's files come from their own request, separate from the
  // sessions poll the page also waits for. Slowing only that request opens
  // the gap: with no file active yet, the page must still wait for the
  // review's document rather than show an empty sheet.
  const create = await request.post(`${baseURL}/api/review-sessions`, {
    data: { filePaths: [fixturePath], origin: 'agent' },
  });
  const { sessionId } = (await create.json()) as { sessionId: string };
  try {
    await page.route(
      (url) => url.pathname === `/api/review-sessions/${sessionId}`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
      },
    );
    await page.addInitScript(() => {
      const frames: string[] = [];
      (window as unknown as { __shown: string[] }).__shown = frames;
      const tick = () => {
        const main = document
          .querySelector('[data-doc-page]')
          ?.closest('.flex-1.min-w-0.flex.flex-col');
        if (main && getComputedStyle(main).visibility === 'visible') {
          const text =
            (document.querySelector('[data-doc-page] .prose')?.childElementCount ?? 0) > 0;
          const banner = !!document.querySelector('[data-testid="review-banner"]');
          frames.push(`text=${text} banner=${banner}`);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.locator('[data-doc-page] .prose > *').first()).toBeVisible({
      timeout: 10_000,
    });
    const shown = await page.evaluate(() => (window as unknown as { __shown: string[] }).__shown);
    expect(shown).toEqual(['text=true banner=true']);
  } finally {
    await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
      headers: { 'content-type': 'application/json' },
    });
  }
});
