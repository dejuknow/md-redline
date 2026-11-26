import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { resetTestAppState } from './helpers/test-state';

// The macOS desktop shell styles the window chrome with SHELL_CHROME_SCRIPT
// (src-tauri/src/main.rs), injected before the page's own scripts. The
// webview's zoom scales the whole page evenly, so the layout in CSS px is the
// same at any zoom and only the script's numbers change with it. That lets
// the real script run here, in a browser at 100%, with each zoom the app
// offers, and the rows be measured against where the traffic lights sit.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const MAIN_RS = resolve(__dirname, '../src-tauri/src/main.rs');

function shellChromeScript(zoom: number): string {
  const source = readFileSync(MAIN_RS, 'utf8');
  const match = source.match(/const SHELL_CHROME_SCRIPT: &str = r#"([\s\S]*?)"#;/);
  if (!match) throw new Error('SHELL_CHROME_SCRIPT not found in main.rs');
  // replaceAll, as Rust's replace does: the name also appears in a comment.
  return match[1].replaceAll('__MDR_ZOOM__', String(zoom));
}

// The lights' center, fixed in window points (traffic_light_position), in CSS
// px at `zoom`. The rows cannot rise above the window's top edge, which caps
// how high their center goes: 8px of padding minus the 8px the offset may
// take back, plus half of a 34px row.
const LIGHTS_CENTER_PT = 31.25;
const expectedCenter = (zoom: number) => Math.max(LIGHTS_CENTER_PT / zoom, 17);

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, TEST_DOC_BASELINE);
});

async function openAsMacApp(page: Page, zoom: number) {
  // WKWebView runs the script once <html> exists; Chromium's init scripts run
  // before that, so it starts on DOMContentLoaded here. The script reads
  // native full screen off the window filling the screen, which a headless
  // window always does, so the screen reports larger.
  await page.addInitScript(`
    Object.defineProperty(screen, 'width', { get: () => window.outerWidth + 200 });
    Object.defineProperty(screen, 'height', { get: () => window.outerHeight + 200 });
    document.addEventListener('DOMContentLoaded', () => {${shellChromeScript(zoom)}});
  `);
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

async function centerY(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} not laid out`);
  return box.y + box.height / 2;
}

test.describe('Desktop shell chrome: traffic lights and the top rows', () => {
  for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
    test(`at ${zoom * 100}% the top rows stay centered on the lights`, async ({ page }) => {
      await openAsMacApp(page, zoom);
      const expected = expectedCenter(zoom);

      // Sidebar open: its top row sits under the lights.
      await expect(page.locator('[data-sidebar-panel]')).toBeVisible();
      expect(await centerY(page, '[data-sidebar-top]')).toBeCloseTo(expected, 0);
      expect(await centerY(page, '[data-doc-strip]')).toBeCloseTo(expected, 0);

      // Collapsed to the rail: the tab strip shares that center.
      await page.keyboard.press(withMod('b'));
      await expect(page.locator('[data-sidebar-rail]')).toBeVisible();
      expect(await centerY(page, '[data-doc-strip]')).toBeCloseTo(expected, 0);

      // Focus mode: the tab strip alone.
      await page.keyboard.press(withMod('.'));
      await expect(page.locator('[data-focus-chip]')).toBeVisible();
      expect(await centerY(page, '[data-doc-strip]')).toBeCloseTo(expected, 0);
    });
  }

  test('at 125% the top rows sit where they do without the shell', async ({ page }) => {
    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });
    const plain = await centerY(page, '[data-sidebar-top]');
    expect(plain).toBeCloseTo(expectedCenter(1.25), 0);
  });

  for (const zoom of [0.8, 1.25, 2]) {
    test(`at ${zoom * 100}% the collapsed rail's icons start below the lights`, async ({
      page,
    }) => {
      await openAsMacApp(page, zoom);
      await page.keyboard.press(withMod('b'));
      const firstIcon = page.locator('[data-sidebar-rail] button').first();
      await expect(firstIcon).toBeVisible();
      const box = await firstIcon.boundingBox();
      // The lights' bottom plus a gap, in CSS px (LIGHTS_BOTTOM_PT / zoom).
      expect(box!.y).toBeGreaterThanOrEqual(43 / zoom - 1);
    });
  }
});

test.describe('Desktop shell chrome: the page corner beside the first tab', () => {
  async function pageCornerRadius(page: Page): Promise<string> {
    return page
      .locator('[data-doc-page-surface]')
      .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  }

  test('squares the corner when the first tab stands on it', async ({ page }) => {
    await openAsMacApp(page, 1.25);
    // Sidebar open: the strip has no inset, so the active first tab is flush.
    await expect(page.locator('[data-tab-flush]')).toHaveCount(1);
    expect(await pageCornerRadius(page)).toBe('0px');
  });

  test('keeps the corner rounded when the window inset pushes the first tab off it', async ({
    page,
  }) => {
    await openAsMacApp(page, 1.25);
    // Focus mode: the strip is padded to clear the lights (#251).
    await page.keyboard.press(withMod('.'));
    await expect(page.locator('[data-focus-chip]')).toBeVisible();
    await expect(page.locator('[data-tab-flush]')).toHaveCount(0);
    expect(await pageCornerRadius(page)).not.toBe('0px');
  });
});
