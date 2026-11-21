import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { grantClipboard } from './helpers/clipboard';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

// Hand off waits for a save still in flight before the prompt is copied.
// Safari refuses a clipboard write that begins after that wait, outside the
// click's own task (#226), so on this path the write starts at the click with
// the prompt held back until the save lands. Playwright's WebKit does not
// enforce Safari's rule, so this cannot catch a write that starts late; it
// checks that the held-back write lands the prompt in both engines.
test('Hand off copies on the first click while a save is still in flight', async ({
  page,
  context,
  browserName,
}) => {
  await grantClipboard(context, browserName);
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await addComment(page, 'authentication system', 'Needs more detail');
  await expect(page.getByTestId('handoff-button')).toBeEnabled({ timeout: 10_000 });

  // Hold the next save until the hand off has been clicked.
  let saveArrived: () => void = () => {};
  const arrived = new Promise<void>((r) => (saveArrived = r));
  let releaseSave: () => void = () => {};
  const released = new Promise<void>((r) => (releaseSave = r));
  await page.route('**/api/file', async (route) => {
    if (route.request().method() === 'PUT') {
      saveArrived();
      await released;
    }
    await route.continue();
  });

  await addComment(page, 'Rate limiting prevents', 'And this one');
  await arrived;
  // The save is held, so the click lands while it is still out.
  await page.getByTestId('handoff-button').click();
  releaseSave();

  await expect(
    page.getByText('Copied agent instructions for 1 file. Now tracking changes.'),
  ).toBeVisible();
  await expect(page.getByText("Couldn't copy to clipboard")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
    .toContain('test-doc.md');
});
