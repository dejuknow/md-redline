import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { addComment, commentsDrawer, openCommentsDrawer } from './helpers/comments';
import { withMod } from './helpers/shortcuts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

// The rail needs roughly 888px of content width to fit (see COL_MIN /
// RAIL_FOOTPRINT in src/lib/page-geometry.ts). A narrow window guarantees it
// never shows, so the FAB/drawer is the only comment surface; a wide one
// guarantees it does.
const NARROW_VIEWPORT = { width: 800, height: 900 };
const WIDE_VIEWPORT = { width: 1700, height: 950 };

test.use({ viewport: NARROW_VIEWPORT });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `comments-drawer-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
  // The rail/column width change and the drawer's overlay animation are
  // both motion-safe; disable motion so assertions read settled state
  // rather than a mid-transition one.
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

async function switchToRaw(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view-table')).toBeVisible();
}

const rail = (page: Page) => page.locator('[data-comments-rail]');

test.describe('Comments drawer', () => {
  test('narrow rendered view: the toolbar comments button opens the drawer, a card activates its anchor, and Escape closes it', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Narrow drawer comment');

    // The rail cannot fit at this width.
    await expect(rail(page)).toHaveCount(0);

    await openCommentsDrawer(page);
    const drawer = commentsDrawer(page);
    const card = drawer.locator('.group.rounded-lg', { hasText: 'Narrow drawer comment' });
    await expect(card).toBeVisible();

    await card.click();
    await expect(page.locator('mark.comment-highlight-active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });

  test('raw view: the drawer lists comments', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Raw view comment');

    await switchToRaw(page);
    // No rail ever shows in raw view, regardless of width.
    await expect(rail(page)).toHaveCount(0);

    await openCommentsDrawer(page);
    await expect(
      commentsDrawer(page).locator('.group.rounded-lg', { hasText: 'Raw view comment' }),
    ).toBeVisible();
  });

  test('wide rendered view: the rail shows and the drawer stays closed', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Wide view comment');

    await page.setViewportSize(WIDE_VIEWPORT);
    await expect(rail(page)).toBeVisible();
    await expect(commentsDrawer(page)).not.toBeVisible();
  });

  test(`${withMod('\\')} at a narrow width toggles the drawer`, async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'valid credentials', 'Shortcut drawer comment');

    const drawer = commentsDrawer(page);
    await expect(drawer).not.toBeVisible();

    await page.keyboard.press(withMod('\\'));
    await expect(drawer).toBeVisible();

    await page.keyboard.press(withMod('\\'));
    await expect(drawer).not.toBeVisible();
  });
});

test.describe('Stranded focus requests route to the drawer', () => {
  // Fixture lives under e2e/fixtures (not node_modules) so the
  // review-sessions API's allowed-roots check passes in worktree checkouts;
  // see the note at the top of agent-asks.spec.ts.
  const ASK_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'comments-drawer-asks-tmp');

  test.afterAll(() => {
    rmSync(ASK_FIXTURE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('raw view: jump to agent question opens the drawer and focuses the card', async ({
    page,
    request,
    baseURL,
  }) => {
    mkdirSync(ASK_FIXTURE_DIR, { recursive: true });
    const askDir = resolve(ASK_FIXTURE_DIR, `jump-${process.pid}-${Date.now()}`);
    mkdirSync(askDir, { recursive: true });
    const askFile = resolve(askDir, 'spec.md');
    writeFileSync(askFile, '# Spec\n\nThe rate limit is 100 req/min today.\n', 'utf8');

    const create = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [askFile], origin: 'agent' },
    });
    expect(create.status()).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    try {
      await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
      await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole('heading', { name: 'Spec' })).toBeVisible({ timeout: 10_000 });
      // Let the SSE file-watcher connection establish before injecting the
      // ask (same guard as agent-asks.spec.ts).
      await page.waitForTimeout(500);

      const ask = await request.post(
        `${baseURL}/api/review-sessions/${sessionId}/agent-comments`,
        {
          data: {
            questions: [
              {
                filePath: askFile,
                anchor: 'rate limit is 100 req/min',
                text: 'per-user or per-tenant?',
              },
            ],
          },
        },
      );
      expect(ask.status()).toBe(201);

      // No comment surface is visible at this width, so the painted highlight
      // mark appearing in the prose is the signal that the ask has landed as
      // a parsed comment.
      await expect(page.locator('mark[data-comment-ids]').first()).toBeVisible({
        timeout: 10_000,
      });

      await switchToRaw(page);
      await expect(commentsDrawer(page)).not.toBeVisible();

      // Jump to the question from the command palette. In raw view the rail
      // cannot exist and the popover cannot render, so the focus request has
      // no surface until the fallback opens the drawer.
      await page.keyboard.press(withMod('k'));
      const paletteInput = page.getByPlaceholder('Type a command...');
      await expect(paletteInput).toBeVisible({ timeout: 3_000 });
      await paletteInput.fill('agent question');
      await page.keyboard.press('Enter');

      const drawer = commentsDrawer(page);
      await expect(drawer).toBeVisible();
      const card = drawer.locator('[data-comment-card-id]', {
        hasText: 'per-user or per-tenant?',
      });
      await expect(card).toBeVisible();
      await expect(card).toBeFocused();
    } finally {
      await request.post(`${baseURL}/api/review-sessions/${sessionId}/abort`, {
        headers: { 'content-type': 'application/json' },
      });
      // The abort triggers an async rewrite of spec.md (clearing the
      // pending-ask flag). Wait for that write to land before the afterAll
      // removes the fixture tree, or the removal races the write.
      await expect
        .poll(() => readFileSync(askFile, 'utf8'), { timeout: 5_000 })
        .not.toContain('"expectsReply":true');
    }
  });
});
