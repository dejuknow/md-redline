import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The server's baseline store lives for the whole Playwright run while browser
// storage is per test, so this spec owns its own fixture file: no other spec
// should POST a baseline for a fixture shared with another spec.
const FIXTURE = resolve(__dirname, 'fixtures/agent-baseline-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

function diffToggle(page: Page) {
  return page.locator('.raw-toolbar button[title*="diff" i]').first();
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

  test('a later Mark reviewed click outranks the agent copy until the agent captures again', async ({
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

    // The agent edits again and captures again: the newer copy re-seeds.
    await request.post(`${baseURL}/api/baselines`, {
      headers: { 'content-type': 'application/json' },
      data: { filePaths: [FIXTURE], agentName: 'Claude' },
    });
    writeFileSync(FIXTURE, TEST_DOC_BASELINE.replace('Section One', 'Section One, revised twice'));
    await expect(page.getByTestId('diff-reference-label')).toContainText("Before Claude's edits", {
      timeout: 15_000,
    });
  });
});
