import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
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

// ---------------------------------------------------------------------------
// Diff view tests
// ---------------------------------------------------------------------------

test.describe('Diff view', () => {
  test('diff toggle appears after handoff creates a snapshot', async ({ page, context }) => {
    await openFixture(page);

    // No diff toggle before handoff
    await expect(page.locator('button[title="View diff since snapshot"]')).not.toBeVisible();

    await takeSnapshotViaHandoff(page, context);

    // Diff toggle should now be visible
    await expect(page.locator('button[title="View diff since snapshot"]')).toBeVisible();
  });

  test('diff view shows "No changes" when content matches snapshot', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);

    // Switch to diff view
    await page.locator('button[title="View diff since snapshot"]').click();

    // Should show "No changes yet"
    await expect(page.getByText('No changes yet')).toBeVisible();
  });

  test('diff view shows changes after external file edit', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);

    // Wait for SSE connection to establish
    await page.waitForTimeout(1500);

    // Modify the file externally — this triggers SSE reload
    const modified = FIXTURE_ORIGINAL.replace('## Section One', '## Updated Section');
    writeFileSync(FIXTURE, modified);

    // The app auto-switches to diff view when an external change is detected
    // and a snapshot exists. Verify the diff content shows both old and new.
    await expect(page.getByText('## Updated Section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('## Section One')).toBeVisible();

    // The "Switch to rendered view" button confirms we're in diff view
    await expect(page.locator('button[title="Switch to rendered view"]')).toBeVisible();
  });

  test('diff view toggle switches back to rendered view', async ({ page, context }) => {
    await openFixture(page);
    await takeSnapshotViaHandoff(page, context);

    // Switch to diff
    await page.locator('button[title="View diff since snapshot"]').click();
    await expect(page.getByText('No changes yet')).toBeVisible();

    // Switch back to rendered
    await page.locator('button[title="Switch to rendered view"]').click();
    await expect(page.locator('.prose')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Section One' })).toBeVisible();
  });

  test('diff view is not available before taking a snapshot', async ({ page }) => {
    await openFixture(page);

    // The diff toggle button should not be present before any snapshot
    const diffBtn = page.locator('button[title="View diff since snapshot"]');
    await expect(diffBtn).not.toBeVisible();
  });
});
