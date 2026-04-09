import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = TEST_DOC_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

/** Trigger a snapshot by adding a comment and handing off to agent. */
async function takeSnapshotViaHandoff(
  page: Page,
  context: { grantPermissions: (p: string[]) => Promise<void> },
) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await addComment(page, 'Section One', 'placeholder');
  await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('handoff-button').click();
  await expect(page.getByText(/snapshot saved/)).toBeVisible({ timeout: 5_000 });
}

/** Switch to raw view via the toolbar button. */
async function switchToRaw(page: Page) {
  await page.locator('button[title="View raw markdown"]').click();
  await expect(page.locator('.raw-view')).toBeVisible({ timeout: 5_000 });
}

/** Locate a toolbar toggle by its title attribute. */
function toggleBtn(page: Page, titlePattern: string): Locator {
  return page.locator(`.raw-toolbar button[title*="${titlePattern}"]`);
}

/** Locate a toolbar text button by its label. */
function toolbarBtn(page: Page, label: string): Locator {
  return page.locator('.raw-toolbar button', { hasText: label });
}

/** Assert that a toolbar toggle button is in its active state. */
async function expectActive(btn: Locator) {
  await expect(btn).toHaveClass(/bg-primary-bg/);
}

/** Assert that a toolbar toggle button is NOT in its active state. */
async function expectInactive(btn: Locator) {
  await expect(btn).not.toHaveClass(/bg-primary-bg/);
}

// ---------------------------------------------------------------------------
// Diff overlay tests (toggle buttons inside raw view toolbar)
// ---------------------------------------------------------------------------

test.describe('Diff overlay', () => {
  test('diff toggle appears in raw view after handoff creates a snapshot', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    await expect(toggleBtn(page, 'diff')).toBeVisible();
  });

  test('diff auto-enables on raw mode entry and shows "No changes" when content matches snapshot', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    // Diff should auto-enable when entering raw mode with a snapshot
    await expectActive(toggleBtn(page, 'diff'));
    await expect(page.getByText('No changes yet')).toBeVisible();
  });

  test('external edit shows toast with View diff action that stays in current view', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(1500);

    const currentContent = readFileSync(FIXTURE, 'utf-8');
    const withReplyAndEdit = currentContent
      .replace('## Section Two', '## Changed Section')
      .replace(
        /"text":"placeholder"/,
        '"text":"placeholder","replies":[{"id":"ext-1","text":"Done","author":"Agent","timestamp":"2026-03-22T00:00:00.000Z"}]',
      );
    writeFileSync(FIXTURE, withReplyAndEdit);

    const viewDiffBtn = page.getByRole('button', { name: 'View diff' });
    await expect(viewDiffBtn).toBeVisible({ timeout: 15_000 });

    // Click the action — should enable the overlay WITHOUT changing view mode.
    // (Diff used to be raw-only, so we'd switch to raw; now both views render
    // the overlay so we stay where the user already is — usually rendered.)
    await viewDiffBtn.click();
    await expect(page.locator('.raw-view')).not.toBeVisible();
    await expectActive(toggleBtn(page, 'diff'));
  });

  test('diff button shows pending badge after external change', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(1500);

    const modified = FIXTURE_ORIGINAL.replace('## Section One', '## Updated Section');
    writeFileSync(FIXTURE, modified);

    await expect(page.getByRole('heading', { name: 'Updated Section' })).toBeVisible({
      timeout: 15_000,
    });

    // The pending pulse now lives on the diff button (since the diff overlay
    // works in any view) — the view-mode toggle no longer carries the dot.
    const diffBtn = toggleBtn(page, 'diff');
    const badge = diffBtn.locator('.animate-pulse');
    await expect(badge).toBeVisible();
  });

  test('toggling diff overlay off stays in raw view', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');

    // Diff is auto-enabled on raw mode entry; "No changes" shows
    await expectActive(diffBtn);
    await expect(page.getByText('No changes yet')).toBeVisible();

    // Toggle off — should stay in raw view without diff
    await diffBtn.click();
    await expectInactive(diffBtn);
    await expect(page.locator('.raw-view')).toBeVisible();
    await expect(page.getByText('No changes yet')).not.toBeVisible();
  });

  test('clear snapshot button disables diff toggle', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');
    await expect(diffBtn).toBeVisible();
    await expect(diffBtn).toBeEnabled();

    await toolbarBtn(page, 'Clear snapshot').click();
    await expect(page.getByText(/snapshot cleared/i)).toBeVisible({ timeout: 5_000 });

    // Diff toggle stays visible (so users discover the feature) but becomes
    // disabled with an explanatory tooltip after the snapshot is cleared.
    await expect(diffBtn).toBeVisible();
    await expect(diffBtn).toBeDisabled();
    await expect(diffBtn).toHaveAttribute('title', /snapshot/i);
  });

  test('diff toggle is visible-but-disabled before taking a snapshot', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');
    await expect(diffBtn).toBeVisible();
    await expect(diffBtn).toBeDisabled();
    await expect(diffBtn).toHaveAttribute('title', /hand off/i);
  });

  test('chunk count badge is visible even when diff overlay is toggled off', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(1500);

    // Introduce a real content change after the snapshot so the diff has chunks
    // (comment markers are stripped by parseComments before computing diff,
    // so we need actual text change, not just an added comment).
    const currentContent = readFileSync(FIXTURE, 'utf-8');
    const modified = currentContent.replace('## Section Two', '## Updated Section Two');
    writeFileSync(FIXTURE, modified);

    // Wait for the external change to land in the rendered view.
    await expect(page.getByRole('heading', { name: 'Updated Section Two' })).toBeVisible({
      timeout: 15_000,
    });

    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');
    await expect(diffBtn).toBeVisible();

    // Diff auto-enables on raw mode entry — count badge should be visible.
    await expectActive(diffBtn);
    const countBadge = diffBtn.locator('span.tabular-nums');
    await expect(countBadge).toBeVisible();
    const countWhenOn = await countBadge.textContent();
    expect(countWhenOn).toMatch(/^\d+$/);

    // Toggle the overlay OFF — the count badge must still be visible
    // (this is the bug fix: previously the badge only showed when overlay was on).
    await diffBtn.click();
    await expectInactive(diffBtn);
    await expect(countBadge).toBeVisible();
    await expect(countBadge).toHaveText(countWhenOn!);
  });

  test('chunk count badge updates from edits made while diff overlay is off', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');
    const countBadge = diffBtn.locator('span.tabular-nums');

    // Auto-enabled on entry, no changes since snapshot — badge hidden.
    await expectActive(diffBtn);
    await expect(countBadge).not.toBeVisible();

    // Toggle overlay OFF before any edit. The "compute while off" path is
    // what we're verifying — the badge must appear and update from edits
    // even though the overlay never gets re-enabled.
    await diffBtn.click();
    await expectInactive(diffBtn);
    await expect(countBadge).not.toBeVisible();

    // First external edit — badge should appear with a count, overlay still off.
    const original = readFileSync(FIXTURE, 'utf-8');
    const firstEdit = original.replace('## Section Two', '## Updated Section Two');
    writeFileSync(FIXTURE, firstEdit);
    await expect(page.locator('.raw-view')).toContainText('Updated Section Two', {
      timeout: 15_000,
    });
    await expectInactive(diffBtn);
    await expect(countBadge).toBeVisible();
    const firstCount = await countBadge.textContent();
    expect(firstCount).toMatch(/^\d+$/);

    // Second external edit changes a different region — count should update,
    // overlay still off.
    const secondEdit = firstEdit.replace('## Section Three', '## Updated Section Three');
    writeFileSync(FIXTURE, secondEdit);
    await expect(page.locator('.raw-view')).toContainText('Updated Section Three', {
      timeout: 15_000,
    });
    await expectInactive(diffBtn);
    await expect(countBadge).toBeVisible();
    await expect(countBadge).not.toHaveText(firstCount!);
  });

  test('raw + diff overlay still shows comment marker rows alongside diff highlights', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);

    // Modify the body so the diff has at least one chunk to render. Use
    // FIXTURE_ORIGINAL as the search target so the replace lands on the
    // unmodified body text (the file now has a comment marker injected near
    // "Section One" but the heading line is untouched).
    await switchToRaw(page);
    const original = readFileSync(FIXTURE, 'utf-8');
    const edited = original.replace(
      'Rate limiting prevents brute force attacks.',
      'Rate limiting prevents brute force attacks and stops scraping bots.',
    );
    writeFileSync(FIXTURE, edited);

    // Wait for the diff to register the new chunk via the panel toolbar badge.
    const diffBtn = toggleBtn(page, 'diff');
    await expect(diffBtn.locator('span.tabular-nums')).toBeVisible({ timeout: 15_000 });
    await expectActive(diffBtn);

    // Marker rows must remain visible in the diff overlay — they were
    // accidentally stripped earlier because the diff was computed on
    // cleanMarkdown. They should re-interleave as unchanged context rows.
    await expect(page.locator('.raw-comment-marker').first()).toBeVisible();

    // The diff highlight on the body should also be there.
    await expect(page.locator('.raw-line-diff-added').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Rendered diff tests — diff toggle lives in the rendered view's pinned
// secondary toolbar (mirrors the raw view structure).
// ---------------------------------------------------------------------------

/** Diff toggle button inside the rendered view's secondary toolbar. */
function renderedDiffBtn(page: Page): Locator {
  return page
    .locator('.raw-toolbar button[title*="diff since snapshot"], .raw-toolbar button[title*="Hide diff overlay"]')
    .first();
}

test.describe('Rendered diff overlay', () => {
  test('rendered toolbar diff button appears after snapshot', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);

    // Should still be in rendered view after handoff
    await expect(page.locator('.prose')).toBeVisible();
    await expect(renderedDiffBtn(page)).toBeVisible();
  });

  test('toggling diff in rendered view stays in rendered view and shows added/removed blocks', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(500);

    // Modify the file externally so the diff has something to show
    const modified = FIXTURE_ORIGINAL.replace(
      'Rate limiting prevents brute force attacks.',
      'Rate limiting prevents brute force attacks and stops scraping bots.',
    );
    writeFileSync(FIXTURE, modified);

    // Wait for the file watcher to pick up the change
    await expect(page.getByText(/stops scraping bots/)).toBeVisible({ timeout: 15_000 });

    // Toggle diff on
    await renderedDiffBtn(page).click();

    // Should still be in rendered (prose) view, not raw
    await expect(page.locator('.raw-view')).not.toBeVisible();

    // Both removed and added blocks should be visible inline
    await expect(page.locator('.rendered-diff-removed')).toBeVisible();
    await expect(page.locator('.rendered-diff-added')).toBeVisible();
  });

  test('toggling diff off in rendered view restores plain rendered view', async ({
    page,
    context,
  }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(500);

    const modified = FIXTURE_ORIGINAL.replace('The authentication system', 'The auth system');
    writeFileSync(FIXTURE, modified);
    await expect(page.getByText(/The auth system/)).toBeVisible({ timeout: 15_000 });

    const diffBtn = renderedDiffBtn(page);
    await diffBtn.click();
    await expect(page.locator('.rendered-diff-added')).toBeVisible();

    // Toggle off
    await diffBtn.click();
    await expect(page.locator('.rendered-diff-added')).not.toBeVisible();
    await expect(page.locator('.rendered-diff-removed')).not.toBeVisible();
    await expect(page.locator('.prose')).toBeVisible();
  });

  test('switching from raw to rendered preserves diff state', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(500);

    const modified = FIXTURE_ORIGINAL.replace('Section Three', 'Section 3');
    writeFileSync(FIXTURE, modified);
    await expect(page.getByRole('heading', { name: 'Section 3' })).toBeVisible({
      timeout: 15_000,
    });

    // Enter raw view (diff auto-enables)
    await switchToRaw(page);
    await expectActive(toggleBtn(page, 'diff'));

    // Switch back to rendered — diff should still be enabled and visible
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('.prose')).toBeVisible();
    await expect(page.locator('.rendered-diff-added').first()).toBeVisible();
    await expect(page.locator('.rendered-diff-removed').first()).toBeVisible();
  });

  test('clear snapshot disables the rendered toolbar diff button', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await expect(renderedDiffBtn(page)).toBeVisible();

    // Clear snapshot from the panel toolbar's Clear snapshot text button.
    await page.locator('.raw-toolbar button', { hasText: 'Clear snapshot' }).first().click();
    await expect(page.getByText(/snapshot cleared/i)).toBeVisible({ timeout: 5_000 });

    // Diff button stays visible (so users discover the feature) but flips
    // to disabled with the "take a snapshot first" tooltip.
    const disabledDiff = page
      .locator('.raw-toolbar button[title*="hand off to take a snapshot"]')
      .first();
    await expect(disabledDiff).toBeVisible();
    await expect(disabledDiff).toBeDisabled();
  });
});
