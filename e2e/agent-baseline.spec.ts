import { test, expect, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The server's baseline store lives for the whole Playwright run while browser
// storage is per test, so this spec owns its own fixture file: no other spec
// should POST a baseline for a fixture shared with another spec.
const FIXTURE = resolve(__dirname, 'fixtures/agent-baseline-doc.md');
// A path this spec captures a baseline for before the file exists, then
// creates. Removed before and after every run so no test starts from a
// leftover file another run left behind.
const NEW_FILE = resolve(__dirname, 'fixtures/agent-baseline-new.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  rmSync(NEW_FILE, { force: true });
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  rmSync(NEW_FILE, { force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

function diffToggle(page: Page) {
  return page
    .locator('.raw-toolbar')
    .locator('button[title^="Show diff"], button[title^="Hide diff"]');
}

test.describe('agent before copy (mdr_baseline)', () => {
  test('an agent-first edit shows a diff labeled with the agent name', async ({
    page,
    request,
    baseURL,
  }) => {
    // 1. The agent announces the file before editing.
    const captured = await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [FIXTURE], agentName: 'Claude' },
    });
    expect(captured.status()).toBe(201);

    // 2. The agent edits.
    writeFileSync(FIXTURE, TEST_DOC_BASELINE.replace('Section One', 'Section One, revised'));

    // 3. The reviewer opens the file.
    await openFixture(page);

    // The diff button enables without any click from the reviewer.
    await expect(diffToggle(page)).toBeEnabled({ timeout: 10_000 });
    await diffToggle(page).click();
    await expect(page.getByTestId('diff-reference-label')).toContainText("Before Claude's edits", {
      timeout: 10_000,
    });
  });

  test("an agent copy never replaces the reviewer's reference, even when called after editing", async ({
    page,
    request,
    baseURL,
  }) => {
    await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [FIXTURE], agentName: 'Claude' },
    });
    writeFileSync(FIXTURE, TEST_DOC_BASELINE.replace('Section One', 'Section One, revised'));
    await openFixture(page);
    await expect(diffToggle(page)).toBeEnabled({ timeout: 10_000 });
    await diffToggle(page).click();
    await expect(page.getByTestId('diff-reference-label')).toContainText("Before Claude's edits");

    // The reviewer catches up: the reference advances and the diff empties.
    await page.locator('.raw-toolbar button', { hasText: 'Mark reviewed' }).click();
    await expect(page.getByTestId('diff-reference-label')).toHaveCount(0);

    // The reviewer's own edit lands after Mark reviewed, then the agent
    // captures a copy of that same, already-newer file. seedReference only
    // fills a gap, so this late capture must never overwrite the reference
    // Mark reviewed just set.
    writeFileSync(FIXTURE, TEST_DOC_BASELINE.replace('Section One', 'Section One, revised twice'));
    await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [FIXTURE], agentName: 'Claude' },
    });
    await expect(page.getByTestId('diff-reference-label')).toContainText('Since last review', {
      timeout: 15_000,
    });

    // Wait past one full poll cycle of the agent-baseline poller: the label
    // must still read "Since last review", never flip to the agent copy.
    await page.waitForTimeout(6_000);
    await expect(page.getByTestId('diff-reference-label')).toContainText('Since last review');
    await expect(page.getByTestId('diff-reference-label')).not.toContainText(
      "Before Claude's edits",
    );
  });

  test('a file the agent is about to create diffs as fully added', async ({
    page,
    request,
    baseURL,
  }) => {
    // The agent announces a file that does not exist yet: an empty copy.
    const captured = await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [NEW_FILE], agentName: 'Claude' },
    });
    expect(captured.status()).toBe(201);
    const { baselines } = (await captured.json()) as { baselines: Array<{ bytes: number }> };
    expect(baselines[0].bytes).toBe(0);

    // The agent creates the file.
    writeFileSync(NEW_FILE, '# New spec\n\nA brand new paragraph.\n');

    await page.goto(`/?file=${NEW_FILE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await expect(diffToggle(page)).toBeEnabled({ timeout: 10_000 });
    await diffToggle(page).click();

    await expect(page.locator('.rendered-diff-added')).toBeVisible();
    await expect(page.getByTestId('diff-reference-label')).toContainText("Before Claude's edits");
  });
});
