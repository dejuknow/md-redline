import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Error states', () => {
  // Anything under /tmp is outside the e2e webServer's cwd, so resolveAndValidate
  // 403s before the file is ever stat'd and before the .md check. These paths
  // therefore land on the permission card, NOT on a 404 or an unsupported-type
  // error, and asserting "some problem was reported" would pass even with those
  // server branches deleted. Assert the card specifically; the 404 and 400
  // branches are the server's own tests to cover.
  const accessCard = (page: import('@playwright/test').Page) => page.getByTestId('access-request');

  test('a non-existent file under a denied root shows the permission card', async ({ page }) => {
    await page.goto('/?file=/tmp/nonexistent-file-abc123.md');

    await expect(accessCard(page)).toBeVisible({ timeout: 10_000 });
    // The heading uses a typographic apostrophe, so match around it.
    await expect(accessCard(page)).toContainText(/read this folder/);
    await expect(accessCard(page).getByTestId('access-request-allow')).toBeVisible();
  });

  test('a non-.md file under a denied root shows the permission card', async ({ page }) => {
    // Create a temporary .txt file
    const txtFile = '/tmp/md-redline-test-error.txt';
    writeFileSync(txtFile, 'This is a plain text file.');

    await page.goto(`/?file=${txtFile}`);

    await expect(accessCard(page)).toBeVisible({ timeout: 10_000 });
  });

  test('app does not crash on error — navigation still works', async ({ page }) => {
    // Load a bad file first
    await page.goto('/?file=/tmp/nonexistent-file-abc123.md');
    await expect(accessCard(page)).toBeVisible({ timeout: 10_000 });

    // Now open a valid file via the file opener
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(FIXTURE);
    await page.getByPlaceholder('File path or name...').press('Enter');

    // Should successfully load the valid file
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('access-denied shows the permission card in the document area', async ({ page }) => {
    // /tmp is outside the e2e webServer's cwd, so this file (even if it
    // existed) would 403 with Access denied. We don't need it to exist; the
    // 403 fires before stat.
    const outOfRootFile = '/tmp/md-redline-e2e-trust-prompt-test.md';
    await page.goto(`/?file=${encodeURIComponent(outOfRootFile)}`);

    // The document area owns the ask: the folder's name, the reason, and the button.
    const card = page.getByTestId('access-request');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('tmp');
    await expect(card.getByTestId('access-request-allow')).toBeVisible();

    // And no surface repeats it as a red error strip. Scoped by role rather
    // than by the toolbar's height utility, which the card's own icon box also
    // happens to carry.
    await expect(page.locator('.text-danger')).toHaveCount(0);
    await expect(page.getByTestId('toolbar-allow-access')).toHaveCount(0);
  });

  test('allowing the folder retries access-denied tabs after grant', async ({ page }) => {
    const testFile = '/tmp/md-redline-e2e-trust-retry-test.md';
    let fileFetchCount = 0;

    // Intercept GET /api/file for our test path. The first call falls through
    // to the real server (which returns 403 because /tmp is outside cwd). The
    // second call (the retry triggered by retryAllAccessDenied) is mocked to
    // return success — simulating the state after the picker grants access.
    await page.route(
      (url) => url.pathname === '/api/file' && url.searchParams.get('path') === testFile,
      async (route) => {
        fileFetchCount++;
        if (fileFetchCount === 1) {
          await route.fallback();
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              path: testFile,
              content: '# Mocked Trust Retry Doc\n\nIt loaded.\n',
              mtime: Date.now(),
            }),
          });
        }
      },
    );

    // Mock the OS picker so we don't pop a real native dialog in CI.
    // Use '**' suffix to match regardless of ?defaultPath=… query param.
    await page.route('**/api/pick-folder**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: testFile }),
      });
    });

    // Navigate to the test file. Real server returns 403 (first /api/file call).
    await page.goto(`/?file=${encodeURIComponent(testFile)}`);

    // Wait for the permission card. The explorer renders its own quieter
    // version of the same ask, so scope to the document area's card.
    const trustButton = page.getByTestId('access-request').getByTestId('access-request-allow');
    await expect(trustButton).toBeVisible({ timeout: 10_000 });

    // Click the button → /api/pick-folder (mocked) → retryAllAccessDenied → second /api/file (mocked).
    await trustButton.click();

    // The mock response should be rendered as a heading.
    await expect(page.getByRole('heading', { name: 'Mocked Trust Retry Doc' })).toBeVisible({
      timeout: 10_000,
    });

    // The error and trust button should be gone after the successful retry.
    await expect(trustButton).toBeHidden();

    // The document that comes back has to have LIVE geometry. The card covers
    // the viewer rather than replacing it because usePageGeometry observes the
    // scroll container once, with deps that do not change when the card
    // clears: replacing the container left the ResizeObserver attached to a
    // detached node, so the sheet kept whatever width it measured before the
    // refusal and stopped tracking the window for the rest of the session.
    //
    // Resize and assert the width follows. The rendered width alone proves
    // nothing here — the stale value is a plausible one, and the sheet's
    // `max-width: calc(100% - 24px)` makes even a dead layout appear to
    // respond — so read the inline width usePageGeometry actually sets.
    const sheet = page.locator('[data-doc-page]');
    await expect(sheet).toBeVisible();
    const widthStyle = () => sheet.evaluate((el) => (el as HTMLElement).style.width);
    const before = await widthStyle();
    expect(before).not.toBe('');

    await page.setViewportSize({ width: 900, height: 720 });
    await expect.poll(widthStyle).not.toBe(before);

    // Sanity check the route handler ran twice.
    expect(fileFetchCount).toBeGreaterThanOrEqual(2);
  });
});
