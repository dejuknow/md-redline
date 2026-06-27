import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

async function proseFontFamily(page: Page): Promise<string> {
  return page
    .locator('.prose')
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
}

test.describe('Prose typeface setting', () => {
  test('defaults to serif and toggles to sans and back', async ({ page }) => {
    await openFixture(page);

    expect(await proseFontFamily(page)).toContain('Source Serif 4');

    // Open settings and switch to Sans.
    await page.locator('button[title*="Settings"]').click();
    await page.getByRole('button', { name: 'Sans', exact: true }).click();
    await page.keyboard.press('Escape');

    expect(await proseFontFamily(page)).not.toContain('Source Serif 4');
    expect(await proseFontFamily(page)).toContain('Inter');

    // Switch back to Serif.
    await page.locator('button[title*="Settings"]').click();
    await page.getByRole('button', { name: 'Serif', exact: true }).click();
    await page.keyboard.press('Escape');

    expect(await proseFontFamily(page)).toContain('Source Serif 4');
  });
});
