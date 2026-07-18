// e2e/update-notice.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const UPGRADE_COMMAND = 'npm install -g md-redline@latest';

// The shared e2e server runs with NO_UPDATE_NOTIFIER=1, so /api/version
// never carries `latest` for other specs. This spec injects it at the
// browser edge with page.route; dismissal still round-trips the real
// PUT /api/preferences.
test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await page.route('**/api/version', (route) =>
    route.fulfill({ json: { version: '0.0.1', latest: '99.0.0' } }),
  );
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Update notice', () => {
  test('appears when the server reports a newer version', async ({ page }) => {
    await openFixture(page);
    const notice = page.locator('[data-update-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('mdr 99.0.0 is available');
    await expect(notice).toContainText(UPGRADE_COMMAND);
  });

  test('copy puts the upgrade command on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await page.locator('[data-update-notice]').getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UPGRADE_COMMAND);
    // Copy must not dismiss: the user may want the command visible while
    // they switch to a terminal.
    await expect(page.locator('[data-update-notice]')).toBeVisible();
  });

  test('dismiss hides the notice and persists across reload', async ({ page }) => {
    await openFixture(page);
    const notice = page.locator('[data-update-notice]');
    await expect(notice).toBeVisible();

    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/preferences') && r.request().method() === 'PUT',
    );
    await notice.getByRole('button', { name: 'Dismiss update notice' }).click();
    await saved;
    await expect(notice).toHaveCount(0);

    // Wait for the open-tabs session to persist (debounce is 500ms; see
    // useSessionPersistence) before reloading. openFixture's URL ?file=
    // param is stripped via history.replaceState right after it opens the
    // tab, so a reload before the debounce fires would lose the open file
    // entirely (same guard e2e/advanced.spec.ts uses around its reloads).
    await page.waitForTimeout(1000);

    // The route stays active across reload; only the persisted dismissal
    // keeps the notice hidden.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Test Document' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-update-notice]')).toHaveCount(0);
  });
});
