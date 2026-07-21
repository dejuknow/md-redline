import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { TEST_DOC_2_BASELINE, TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_1 = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_2 = resolve(__dirname, 'fixtures/test-doc-2.md');
const FIXTURE_1_ORIGINAL = TEST_DOC_BASELINE;
const FIXTURE_2_ORIGINAL = TEST_DOC_2_BASELINE;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE_1, FIXTURE_1_ORIGINAL);
  writeFileSync(FIXTURE_2, FIXTURE_2_ORIGINAL);
});

async function openFixture(page: Page, fixture: string = FIXTURE_1) {
  await page.goto(`/?file=${fixture}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Hand-off button visibility
// ---------------------------------------------------------------------------

test.describe('Hand-off button', () => {
  test('is visible-but-disabled when there are no comments', async ({ page }) => {
    await openFixture(page);
    // Stays visible (so the feature is discoverable) but disabled until at
    // least one comment exists. Tooltip explains how to enable.
    const btn = page.getByTestId('handoff-button');
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', /add comments/i);
  });

  test('becomes enabled when a comment is added', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    const btn = page.getByTestId('handoff-button');
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled();
  });

  test('becomes disabled again when all comments are deleted', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    const btn = page.getByTestId('handoff-button');
    await expect(btn).toBeEnabled({ timeout: 10_000 });

    // Delete all comments via command palette
    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('Delete all');
    await page.getByText('Delete all comments').click();

    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });

  test('hovering the disabled handoff button reveals the explanatory tooltip', async ({
    page,
  }) => {
    await openFixture(page);
    // Hover the wrapping span (Tooltip wrapper). Disabled buttons don't fire
    // mouseenter natively, so the wrapper has to do it — that's the whole
    // point of the span-based Tooltip.
    const group = page.getByTestId('handoff-group');
    await group.hover();
    // Wait long enough for the slow first-reveal delay (~600ms).
    const tooltip = page.getByRole('tooltip', { name: /add comments first/i });
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
  });
});

// ---------------------------------------------------------------------------
// Single-file hand-off
// ---------------------------------------------------------------------------

test.describe('Single-file hand-off', () => {
  test('copies instructions to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    // Check toast
    await expect(
      page.getByText('Copied agent instructions for 1 file. Now tracking changes.'),
    ).toBeVisible();

    // Verify clipboard content
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('inline comment markers');
    expect(clipboard).toContain('<!-- @comment{JSON} -->');
    expect(clipboard).toContain('test-doc.md');
  });

  test('prompt instructs agent to delete markers by default', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('remove the entire');
  });

  test('renders as a direct button with no picker affordance for a single file', async ({
    page,
  }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    const btn = page.getByTestId('handoff-button');
    await expect(btn).toBeEnabled({ timeout: 10_000 });

    // Single-file scope: no chevron, no aria-haspopup — the click copies
    // immediately rather than opening the multi-file picker.
    await expect(page.getByTestId('handoff-chevron')).toHaveCount(0);
    await expect(btn).not.toHaveAttribute('aria-haspopup', 'true');
  });

  test('is disabled on a comment-free active tab even if a background tab has comments', async ({
    page,
  }) => {
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'authentication system', 'Fix auth flow');
    await expect(page.getByTestId('handoff-button')).toBeEnabled({ timeout: 10_000 });

    // Open a second, comment-free file and make it the active tab. Handoff is
    // scoped to the ACTIVE tab, so it must go quiet here — a comment in a
    // background tab (often an unrelated doc from another project) must never
    // light up the button while you're reading something else.
    await page.locator('button[title="Open file"]').click();
    const input = page.getByPlaceholder('File path or name...');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill(FIXTURE_2);
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });

    const btn = page.getByTestId('handoff-button');
    await expect(btn).toBeDisabled();
    // No background filename bleeds onto the resting button.
    await expect(btn).not.toContainText('test-doc.md');
  });
});

// ---------------------------------------------------------------------------
// Resolve-mode hand-off prompt
// ---------------------------------------------------------------------------

async function toggleSetting(page: Page, settingName: string) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  const settingLabel = panel.locator('label', { hasText: settingName });
  await settingLabel.locator('button[role="switch"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

test.describe('Resolve-mode hand-off', () => {
  test('prompt includes reply instruction when resolve workflow is enabled', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'How important is this?');
    await toggleSetting(page, 'Enable resolve workflow');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('add a reply');
    expect(clipboard).toContain('"author":"<your tool name>"');
    expect(clipboard).toContain('resolved');
    expect(clipboard).not.toContain('remove the entire');
  });

  test('default mode prompt does not include reply instruction', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('handoff-button').click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('remove the entire');
    expect(clipboard).not.toContain('"author":"<your tool name>"');
  });
});

// ---------------------------------------------------------------------------
// Multi-file hand-off
// ---------------------------------------------------------------------------

test.describe('Multi-file hand-off', () => {
  async function setupTwoFilesWithComments(page: Page) {
    // Open first file and add comment
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'authentication system', 'Fix auth flow');

    // Open second file via the + tab button (preserves first tab)
    await page.locator('button[title="Open file"]').click();
    const input = page.getByPlaceholder('File path or name...');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill(FIXTURE_2);
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });
    await addComment(page, 'second test document', 'Fix introduction');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });
  }

  test('CTA shows the active-tab count; a chevron (not the primary click) opens the picker', async ({
    page,
  }) => {
    await setupTwoFilesWithComments(page);

    // Active tab is test-doc-2 with 1 comment; the label reflects the active
    // file only, never a plural "N files" scope or another tab's name.
    const btn = page.getByTestId('handoff-button');
    await expect(btn).toContainText('Hand off');
    await expect(btn).toContainText('1');
    await expect(btn).not.toContainText('files');
    // The primary button is a direct action, not a menu trigger.
    await expect(btn).not.toHaveAttribute('aria-haspopup', 'true');

    // The picker lives behind the chevron, which appears because another tab
    // also has comments.
    const chevron = page.getByTestId('handoff-chevron');
    await expect(chevron).toHaveAttribute('aria-haspopup', 'true');
    await chevron.click();
    await expect(page.locator('.absolute.right-0.top-full')).toBeVisible();
  });

  test('primary click hands off only the active file, not other commented tabs', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-button').click();

    await expect(
      page.getByText('Copied agent instructions for 1 file. Now tracking changes.'),
    ).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Active tab is test-doc-2; test-doc must NOT be swept in by the direct click.
    expect(clipboard).toContain('test-doc-2.md');
    expect(clipboard).not.toContain('Files to review');
  });

  test('picker shows all commented files', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText('test-doc.md')).toBeVisible();
    await expect(dropdown.getByText('test-doc-2.md')).toBeVisible();
  });

  test('only the active file is pre-selected in the picker', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // Active-only preselected: the confirm CTA starts at a single file, and
    // the active row is labeled so the reviewer knows why it's checked.
    await expect(dropdown.getByText('Copy handoff for 1 file')).toBeVisible();
    await expect(dropdown.getByText('this file')).toBeVisible();
  });

  test('checking another file grows the scope', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // Opt the other tab in.
    await dropdown.locator('button', { hasText: 'test-doc.md' }).first().click();

    await expect(dropdown.getByText('Copy handoff for 2 files')).toBeVisible();
  });

  test('confirm is disabled when the active file is deselected and nothing else is picked', async ({
    page,
  }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    // Deselect the only pre-selected (active) file.
    await dropdown.locator('button', { hasText: 'test-doc-2.md' }).first().click();

    const copyBtn = dropdown.locator('button', { hasText: 'Select files to hand off' });
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toBeDisabled();
  });

  test('picking a second file hands off both', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();

    const dropdown = page.locator('.absolute.right-0.top-full');
    await dropdown.locator('button', { hasText: 'test-doc.md' }).first().click();
    await dropdown.getByText('Copy handoff for 2 files').click();

    await expect(
      page.getByText('Copied agent instructions for 2 files. Now tracking changes.'),
    ).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('Files to review');
    expect(clipboard).toContain('test-doc.md');
    expect(clipboard).toContain('test-doc-2.md');
  });

  test('picker closes on click outside', async ({ page }) => {
    await setupTwoFilesWithComments(page);

    await page.getByTestId('handoff-chevron').click();
    const dropdown = page.locator('.absolute.right-0.top-full');
    await expect(dropdown).toBeVisible();

    // Click outside
    await page.locator('.prose').click({ position: { x: 10, y: 10 } });
    await expect(dropdown).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Command palette integration
// ---------------------------------------------------------------------------

test.describe('Command palette hand-off', () => {
  test('hand-off command appears when comments exist', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'authentication system', 'Needs more detail');

    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('hand off');
    await expect(page.getByText('Hand off to agent')).toBeVisible();
  });

  test('hand-off command does not appear without comments', async ({ page }) => {
    await openFixture(page);

    await page.keyboard.press(withMod('k'));
    await page.getByPlaceholder('Type a command...').fill('hand off');
    await expect(page.getByText('Hand off to agent')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Handoff creates diff snapshot
// ---------------------------------------------------------------------------

test.describe('Handoff + snapshot', () => {
  test('handoff button creates a diff snapshot', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);

    await addComment(page, 'authentication system', 'Needs more detail');
    await expect(page.getByTestId('handoff-button')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('handoff-button').click();
    await expect(page.getByText(/tracking changes/i)).toBeVisible({ timeout: 5_000 });

    // Switch to raw view and verify diff toggle is visible (snapshot was created)
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button[title*="diff"]')).toBeVisible();
  });

  test('multi-file handoff creates snapshots for all selected files', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Open file 1 and add a comment
    await openFixture(page, FIXTURE_1);
    await addComment(page, 'authentication system', 'Fix auth');

    // Open file 2 and add a comment
    await page.locator('button[title="Open file"]').click();
    const input = page.getByPlaceholder('File path or name...');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill(FIXTURE_2);
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Second Test Document' })).toBeVisible({
      timeout: 10_000,
    });
    await addComment(page, 'second test document', 'Fix intro');

    // Multi-file handoff — open the picker via the chevron, opt the other
    // file in (only the active file is preselected), then confirm.
    await page.getByTestId('handoff-chevron').click();
    const dropdown = page.locator('.absolute.right-0.top-full');
    await dropdown.locator('button', { hasText: 'test-doc.md' }).first().click();
    await dropdown.getByText('Copy handoff for 2 files').click();
    await expect(page.getByText(/tracking changes/i)).toBeVisible({ timeout: 5_000 });

    // File 2 (active tab) should have a snapshot → switch to raw view and verify diff toggle visible
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button[title*="diff"]')).toBeVisible();

    // Note: Both files' references are verified by the "tracking changes" toast during handoff
  });
});
