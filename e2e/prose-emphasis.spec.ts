import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { EMPHASIS_DOC_BASELINE } from './helpers/fixture-baselines';
import { withMod } from './helpers/shortcuts';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/emphasis-doc.md');
const FIXTURE_ORIGINAL = EMPHASIS_DOC_BASELINE;

/**
 * Emphasis contract, rendered and raw.
 *
 * Body copy renders at full ink in every theme, and emphasis is carried by
 * weight, with bold defaulting to the same color as body. Dark themes opt out
 * through per-theme tokens (--theme-prose-bold, --theme-prose-body-weight,
 * --theme-prose-bold-weight, --theme-raw-bold-weight) because light-on-dark
 * text blooms and eats the stock 400/600 gap.
 *
 * These assert the token contract and its direction, not the literal design
 * values, so a theme that never opts in keeps the plugin's stock pair and
 * retuning the numbers does not require editing tests.
 */

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  // These tests switch themes, which persists server-side into a prefs file
  // shared by every spec.
  clearPersistedPreferences();
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose strong').first().waitFor({ timeout: 10_000 });
}

async function selectTheme(page: Page, themeName: string, themeKey: string) {
  await page.keyboard.press(withMod('k'));
  await page.getByPlaceholder('Type a command...').fill(`Theme: ${themeName}`);
  await page.keyboard.press('Enter');
  await expect(page.getByPlaceholder('Type a command...')).not.toBeVisible();
  // Settle gate: computed styles are only meaningful once the attribute flips.
  await expect(page.locator(`[data-theme="${themeKey}"]`)).toBeVisible();
}

type Ink = { color: string; weight: number };

async function ink(page: Page, selector: string): Promise<Ink> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, weight: Number(cs.fontWeight) };
    });
}

/**
 * Read a theme token off the root, not off `.prose`: the tokens are inherited
 * custom properties and the raw view has no `.prose` element to hang them on.
 */
async function themeTone(page: Page, custom: string): Promise<string> {
  const hex = await page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    custom,
  );
  return hexToRgb(hex);
}

/** Relative luminance, so "brighter" can be asserted without hardcoding hexes. */
function luminance(cssColor: string): number {
  const [r, g, b] = cssColor
    .match(/\d+(\.\d+)?/g)!
    .slice(0, 3)
    .map(Number);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// [palette label, data-theme key]. Mirrors DARK_THEMES / LIGHT_THEMES in
// src/lib/themes.ts; e2e specs do not import app source, so a theme added there
// must be added here too. Every light theme is exercised, not just the default,
// because the contract's claim is that a theme setting none of the tokens gets
// the plugin's stock pair.
const DARK_THEMES: Array<[string, string]> = [
  ['Dark', 'dark'],
  ['Nord', 'nord'],
  ['Rosé Pine', 'rose-pine'],
  ['Catppuccin', 'catppuccin'],
];

const LIGHT_THEMES: Array<[string, string]> = [
  ['Light', 'light'],
  ['Sepia', 'sepia'],
  ['Solarized', 'solarized'],
  ['GitHub', 'github'],
];

test.describe('Prose emphasis contract', () => {
  test('light themes carry emphasis with weight alone', async ({ page }) => {
    await openFixture(page);

    // Selected explicitly rather than relying on how `system` resolves under
    // Playwright's default colorScheme.
    for (const [name, key] of LIGHT_THEMES) {
      await selectTheme(page, name, key);

      const body = await ink(page, '.prose p');
      const bold = await ink(page, '.prose p strong');

      // No theme tokens set, so the plugin's stock pair applies.
      expect(body.weight, `${name} body weight`).toBe(400);
      expect(bold.weight, `${name} bold weight`).toBe(600);
      // Emphasis is weight, not color: --tw-prose-bold falls back to
      // --theme-text.
      expect(bold.color, `${name} bold color`).toBe(body.color);
    }
  });

  test('body copy renders at full ink, not the secondary tone', async ({ page }) => {
    await openFixture(page);

    const text = await themeTone(page, '--theme-text');
    const secondary = await themeTone(page, '--theme-text-secondary');
    const body = await ink(page, '.prose p');

    // Guards the regression this contract was written for: body used to resolve
    // to --theme-text-secondary, which reads as gray against a dark sheet.
    expect(text).not.toBe(secondary);
    expect(body.color).toBe(text);
  });

  test('quiet document text clears the muted tone', async ({ page }) => {
    await openFixture(page);

    const secondary = await themeTone(page, '--theme-text-secondary');
    const muted = await themeTone(page, '--theme-text-muted');
    expect(secondary).not.toBe(muted);

    // List markers are quieter than body but are still document content, and
    // muted drops under 3.5:1 on three of the dark palettes.
    const markerColor = await page
      .locator('.prose ol li')
      .first()
      .evaluate((el) => getComputedStyle(el, '::marker').color);
    expect(markerColor).toBe(secondary);

    // Fenced code tracks body ink rather than the secondary, so code no longer
    // trails the prose around it.
    const code = await ink(page, '.prose pre');
    expect(code.color).toBe(await themeTone(page, '--theme-text'));
  });

  test('heading and blockquote emphasis keeps the plugin ladder', async ({ page }) => {
    await openFixture(page);

    const themes: Array<[string, string]> = [...LIGHT_THEMES, ...DARK_THEMES];
    for (const [name, key] of themes) {
      await selectTheme(page, name, key);

      const h2 = await ink(page, '.prose h2');
      const h2strong = await ink(page, '.prose h2 strong');
      const bodyStrong = await ink(page, '.prose p strong');
      const quote = await ink(page, '.prose blockquote p');
      const quoteStrong = await ink(page, '.prose blockquote strong');

      // Emphasis inside a heading must never render lighter than the heading
      // itself, which is what a flat body-copy weight rule does to it. Headings
      // are the only block with a plugin strong ladder, so h2 strong outranks
      // both its heading and ordinary body bold.
      expect(h2strong.weight, `${name} h2 strong`).toBeGreaterThan(h2.weight);
      expect(h2strong.weight, `${name} h2 strong vs body`).toBeGreaterThan(bodyStrong.weight);
      // Quoted body keeps the plugin's 500 rather than the thinned body weight.
      expect(quote.weight, `${name} blockquote body`).toBe(500);
      // The plugin gives blockquote strong a color rule but no weight, so
      // emphasis in a quote must take the same weight body bold gets. Asserting
      // only that it beats the quote's own 500 would pass at the stock 600 and
      // hide quoted bold being the weakest emphasis on the page.
      expect(quoteStrong.weight, `${name} blockquote strong`).toBe(bodyStrong.weight);
    }
  });

  test('list items and table cells track the body weight', async ({ page }) => {
    await openFixture(page);

    for (const [name, key] of [...LIGHT_THEMES, ...DARK_THEMES]) {
      await selectTheme(page, name, key);

      const body = await ink(page, '.prose p');
      // The rule names p, li, and td explicitly; drop one and body copy in that
      // block silently reverts to the inherited weight.
      expect((await ink(page, '.prose li')).weight, `${name} li`).toBe(body.weight);
      expect((await ink(page, '.prose td')).weight, `${name} td`).toBe(body.weight);
      // Table headers have no plugin strong ladder either, so emphasis in a
      // cell or a header takes the same weight body bold gets.
      const bodyStrong = await ink(page, '.prose p strong');
      expect((await ink(page, '.prose td strong')).weight, `${name} td strong`).toBe(
        bodyStrong.weight,
      );
      expect((await ink(page, '.prose th strong')).weight, `${name} th strong`).toBe(
        bodyStrong.weight,
      );
    }
  });

  test('dark themes thin body and lift bold past full ink', async ({ page }) => {
    await openFixture(page);

    for (const [name, key] of DARK_THEMES) {
      await selectTheme(page, name, key);

      const body = await ink(page, '.prose p');
      const bold = await ink(page, '.prose p strong');

      // Dark themes opt out of the stock pair in both directions.
      expect(body.weight, `${name} body weight`).toBeLessThan(400);
      expect(bold.weight, `${name} bold weight`).toBeGreaterThan(600);
      // ...and bold sits above body tonally, never below it.
      expect(luminance(bold.color), `${name} bold tone`).toBeGreaterThan(luminance(body.color));
    }
  });

  test('highlighting a bold phrase does not change its ink', async ({ page }) => {
    await openFixture(page);
    await selectTheme(page, 'Dark', 'dark');

    const bareBold = await ink(page, '.prose p strong');

    // Anchoring exactly the bold run nests the mark INSIDE the <strong>
    // (surroundContents), which is the shape where the mark's own color wins.
    // An anchor that spilled past the bold would nest the other way and hide
    // the defect, so the phrase has to match the bold run exactly.
    await addComment(page, 'Lead-in claim.', 'Highlight ink test');
    const mark = page.locator('.prose p strong mark.comment-highlight').first();
    await expect(mark).toBeVisible();

    const highlighted = await ink(page, '.prose p strong mark.comment-highlight');
    expect(highlighted.color).toBe(bareBold.color);
    expect(highlighted.weight).toBe(bareBold.weight);
  });

  test('raw view follows the same tokens', async ({ page }) => {
    await openFixture(page);
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('.raw-view-table')).toBeVisible();
    await selectTheme(page, 'Light', 'light');

    const lightLine = await ink(page, '.raw-line-content');
    const lightBold = await ink(page, '.raw-bold');

    // Light: markup is ink-colored at the stock weight, same as the source text.
    expect(lightBold.weight).toBe(600);
    expect(lightBold.color).toBe(lightLine.color);
    // Source text is body ink, not the secondary it used to resolve to.
    expect(lightLine.color).toBe(await themeTone(page, '--theme-text'));
    // Table rows have always matched plain lines; they must not be left behind.
    expect((await ink(page, '.raw-table')).color).toBe(lightLine.color);
    // Quoted source lines are document text, so they clear the muted tone.
    expect((await ink(page, '.raw-blockquote')).color).toBe(
      await themeTone(page, '--theme-text-secondary'),
    );
    // Fenced source blocks take --theme-code-text, which falls back to body ink
    // rather than the secondary. No theme overrides it today, so this asserts
    // the fallback arm the docs describe.
    expect((await ink(page, '.raw-code-block')).color).toBe(await themeTone(page, '--theme-text'));
    // Heading markup lifts with bold, sharing --theme-raw-bold-weight.
    expect((await ink(page, '.raw-heading')).weight).toBe(lightBold.weight);

    await selectTheme(page, 'Dark', 'dark');

    const darkLine = await ink(page, '.raw-line-content');
    const darkBold = await ink(page, '.raw-bold');

    // Dark: markup lifts, but source text stays at 400. That view is 13px mono,
    // where the rendered view's 350 goes spindly.
    expect(darkLine.weight).toBe(400);
    expect(darkBold.weight).toBeGreaterThan(600);
    expect(luminance(darkBold.color)).toBeGreaterThan(luminance(darkLine.color));
  });
});

/** `getPropertyValue` returns the authored hex; computed colors come back rgb(). */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
