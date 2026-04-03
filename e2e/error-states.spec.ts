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
    const errorText = page.locator('.text-danger');
    await expect(errorText).toBeVisible({ timeout: 10_000 });
    const text = await errorText.textContent();
    // Error message should indicate the file wasn't found or isn't readable
    expect(text?.toLowerCase()).toMatch(/not found|not readable|error|denied/);
  });

  test('opening a non-.md file shows an error', async ({ page }) => {
    // Create a temporary .txt file
    const txtFile = '/tmp/md-redline-test-error.txt';
    writeFileSync(txtFile, 'This is a plain text file.');

    await page.goto(`/?file=${txtFile}`);

    // The toolbar should show an error about unsupported file type
    const errorText = page.locator('.text-danger');
    await expect(errorText).toBeVisible({ timeout: 10_000 });
    const text = await errorText.textContent();
    // Should indicate that only .md files are supported
    expect(text?.toLowerCase()).toMatch(/\.md|not supported|supported|error|denied/);
  });

  test('app does not crash on error — navigation still works', async ({ page }) => {
    // Load a bad file first
    await page.goto('/?file=/tmp/nonexistent-file-abc123.md');
    await expect(page.locator('.text-danger')).toBeVisible({ timeout: 10_000 });

    // Now open a valid file via the file opener
    await page.locator('button[title="Open file"]').click();
    await page.getByPlaceholder('File path or name...').fill(FIXTURE);
    await page.getByPlaceholder('File path or name...').press('Enter');

    // Should successfully load the valid file
    await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
