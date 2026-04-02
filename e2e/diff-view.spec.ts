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
async function takeSnapshotViaHandoff(page: Page, context: { grantPermissions: (p: string[]) => Promise<void> }) {
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
  test('diff toggle appears in raw view after handoff creates a snapshot', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    await expect(toggleBtn(page, 'diff')).toBeVisible();
  });

  test('diff toggle shows "No changes" when content matches snapshot', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    await toggleBtn(page, 'diff').click();
    await expect(page.getByText('No changes yet')).toBeVisible();
  });

  test('comments toggle hides and shows comment markers', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const commentsBtn = toggleBtn(page, 'comment marker');
    await expectActive(commentsBtn);

    // Hide comments
    await commentsBtn.click();
    await expectInactive(commentsBtn);
    await expect(page.locator('.raw-view-comments-hidden')).toBeVisible();

    // Show comments again
    await commentsBtn.click();
    await expectActive(commentsBtn);
    await expect(page.locator('.raw-view-comments-hidden')).not.toBeVisible();
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

    await expect(page.getByRole('heading', { name: 'Updated Section' })).toBeVisible({ timeout: 15_000 });

    const rawBtn = page.locator('button[title="View raw markdown"]');
    const badge = rawBtn.locator('.animate-pulse');
    await expect(badge).toBeVisible();
  });

  test('toggling diff overlay off stays in raw view', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);
    await switchToRaw(page);

    const diffBtn = toggleBtn(page, 'diff');

    await diffBtn.click();
    await expect(page.getByText('No changes yet')).toBeVisible();

    await diffBtn.click();
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
});
