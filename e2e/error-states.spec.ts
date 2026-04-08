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
  test('opening a non-existent file shows an error', async ({ page }) => {
    await page.goto('/?file=/tmp/nonexistent-file-abc123.md');

    // The toolbar should show an error message (rendered with text-danger class)
    const errorText = page.locator('.text-danger').first();
    await expect(errorText).toBeVisible({ timeout: 10_000 });
    const text = await errorText.textContent();
    // Error message should indicate an access or load problem (the new
    // friendly copy replaces "denied" with an "allow ..." prompt; both
    // are valid).
    expect(text?.toLowerCase()).toMatch(/not found|not readable|error|denied|allow/);
  });

  test('opening a non-.md file shows an error', async ({ page }) => {
    // Create a temporary .txt file
    const txtFile = '/tmp/md-redline-test-error.txt';
    writeFileSync(txtFile, 'This is a plain text file.');

    await page.goto(`/?file=${txtFile}`);

    // The toolbar should show an error about unsupported file type
    const errorText = page.locator('.text-danger').first();
    await expect(errorText).toBeVisible({ timeout: 10_000 });
    const text = await errorText.textContent();
    // Should indicate either an unsupported-file error OR an access-denied
    // prompt (the latter fires first because /tmp is outside cwd).
    expect(text?.toLowerCase()).toMatch(/\.md|not supported|supported|error|denied|allow/);
  });

  test('app does not crash on error — navigation still works', async ({ page }) => {
    // Load a bad file first
    await page.goto('/?file=/tmp/nonexistent-file-abc123.md');
    await expect(page.locator('.text-danger').first()).toBeVisible({ timeout: 10_000 });

    // Now open a valid file via the file opener
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(FIXTURE);
    await page.getByPlaceholder('File path or name...').press('Enter');

    // Should successfully load the valid file
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('access-denied error shows the Allow access button', async ({ page }) => {
    // /tmp is outside the e2e webServer's cwd, so this file (even if it
    // existed) would 403 with Access denied. We don't need it to exist; the
    // 403 fires before stat.
    const outOfRootFile = '/tmp/md-redline-e2e-trust-prompt-test.md';
    await page.goto(`/?file=${encodeURIComponent(outOfRootFile)}`);

    // The toolbar should show the friendly permission prompt.
    const errorText = page.locator('.text-danger').first();
    await expect(errorText).toBeVisible({ timeout: 10_000 });
    const text = await errorText.textContent();
    expect(text?.toLowerCase()).toContain('allow');

    // The Allow access button must be visible alongside the prompt. Both
    // the toolbar and the file explorer can render trust buttons in this
    // scenario (since /tmp is denied for both file load and dir browse);
    // scope to the toolbar's button by using its <span class="text-danger">
    // parent (the explorer wraps its error in a <div>, not a <span>).
    const trustButton = page.locator('span.text-danger button', { hasText: 'Allow access' });
    await expect(trustButton).toBeVisible({ timeout: 5_000 });
  });

  test('clicking Allow access retries access-denied tabs after grant', async ({ page }) => {
    const testFile = '/tmp/md-redline-e2e-trust-retry-test.md';
    let fileFetchCount = 0;

    // Intercept GET /api/file for our test path. The first call falls through
    // to the real server (which returns 403 because /tmp is outside cwd). The
    // second call (the retry triggered by retryAllAccessDenied) is mocked to
    // return success — simulating the state after the picker grants access.
    await page.route(
      (url) =>
        url.pathname === '/api/file' && url.searchParams.get('path') === testFile,
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

    // Wait for the access-denied error and the trust button. Both the
    // toolbar and the file explorer render trust buttons here; we scope
    // to the toolbar's button via its <span class="text-danger"> parent
    // (the explorer wraps its error in a <div>, not a <span>).
    const trustButton = page.locator('span.text-danger button', { hasText: 'Allow access' });
    await expect(trustButton).toBeVisible({ timeout: 10_000 });

    // Click the button → /api/pick-folder (mocked) → retryAllAccessDenied → second /api/file (mocked).
    await trustButton.click();

    // The mock response should be rendered as a heading.
    await expect(
      page.getByRole('heading', { name: 'Mocked Trust Retry Doc' }),
    ).toBeVisible({ timeout: 10_000 });

    // The error and trust button should be gone after the successful retry.
    await expect(trustButton).toBeHidden();

    // Sanity check the route handler ran twice.
    expect(fileFetchCount).toBeGreaterThanOrEqual(2);
  });
});
