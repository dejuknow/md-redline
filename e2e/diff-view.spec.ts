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

  test('comments toggle hides and shows comment markers', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const commentsBtn = toggleBtn(page, 'comment marker');
    // Comments are hidden by default when diff is auto-enabled
    await expectInactive(commentsBtn);
    await expect(page.locator('.raw-view-comments-hidden')).toBeVisible();

    // Show comments
    await commentsBtn.click();
    await expectActive(commentsBtn);
    await expect(page.locator('.raw-view-comments-hidden')).not.toBeVisible();

    // Hide comments again
    await commentsBtn.click();
    await expectInactive(commentsBtn);
    await expect(page.locator('.raw-view-comments-hidden')).toBeVisible();
  });

  test('external edit shows toast with View diff action', async ({ page, context }) => {
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

    // Click the action — should switch to raw view with diff enabled
    await viewDiffBtn.click();
    await expect(page.locator('.raw-view')).toBeVisible();
    await expectActive(toggleBtn(page, 'diff'));
  });

  test('raw button shows pending badge after external change', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await page.waitForTimeout(1500);

    const modified = FIXTURE_ORIGINAL.replace('## Section One', '## Updated Section');
    writeFileSync(FIXTURE, modified);

    await expect(page.getByRole('heading', { name: 'Updated Section' })).toBeVisible({
      timeout: 15_000,
    });

    const rawBtn = page.locator('button[title="View raw markdown"]');
    const badge = rawBtn.locator('.animate-pulse');
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

  test('clear snapshot button removes diff toggle', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');
    await expect(diffBtn).toBeVisible();

    await toolbarBtn(page, 'Clear snapshot').click();
    await expect(page.getByText(/snapshot cleared/i)).toBeVisible({ timeout: 5_000 });

    await expect(diffBtn).not.toBeVisible();
  });

  test('diff toggle is not available before taking a snapshot', async ({ page }) => {
    await openFixture(page);
    await switchToRaw(page);

    await expect(toggleBtn(page, 'diff')).not.toBeVisible();
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
});
