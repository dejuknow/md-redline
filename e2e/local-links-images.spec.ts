import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTE = resolve(__dirname, 'fixtures/local-links/note.md');
const SIBLING = resolve(__dirname, 'fixtures/local-links/sibling.md');

test.beforeEach(async ({ page }) => {
  await resetTestAppState(page);
});

async function openNote(page: Page) {
  await page.goto(`/?file=${NOTE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

test.describe('local links and images', () => {
  test('renders a relative image via /api/asset', async ({ page }) => {
    await openNote(page);
    const img = page.locator('.prose img[alt="pixel"]');
    await expect(img).toBeVisible();

    const src = await img.getAttribute('src');
    expect(src).toContain('/api/asset?path=');
    expect(src).toContain(encodeURIComponent('pixel.png'));

    // The image actually loads — wait for the browser to finish loading it,
    // then verify naturalWidth > 0. Without the explicit wait, naturalWidth
    // could be 0 in slow CI before the load completes.
    const loaded = await img.evaluate((el) => {
      const image = el as HTMLImageElement;
      if (image.complete && image.naturalWidth > 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        image.addEventListener('load', () => resolve(image.naturalWidth > 0));
        image.addEventListener('error', () => resolve(false));
      });
    });
    expect(loaded).toBe(true);
  });

  test('clicking a relative .md link opens the sibling in a new app tab', async ({ page }) => {
    await openNote(page);

    const link = page.locator('.prose a', { hasText: 'Open sibling' });
    await expect(link).toBeVisible();
    // The rewriter sets href="#" and stores the absolute path in data-*
    await expect(link).toHaveAttribute('href', '#');
    await expect(link).toHaveAttribute('data-mdr-local-md', SIBLING);

    await link.click();

    // The sibling's app tab becomes active and its content renders
    await expect(page.locator('.prose h1', { hasText: 'Sibling Document' })).toBeVisible({
      timeout: 5_000,
    });
  });
});
