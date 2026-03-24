import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/test-doc.md');
const FIXTURE_ORIGINAL = readFileSync(FIXTURE, 'utf-8');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FIXTURE_ORIGINAL);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

const searchBar = (page: Page) => page.locator('[data-testid="search-bar"]');
const searchInput = (page: Page) => searchBar(page).getByPlaceholder('Find...');
const matchCount = (page: Page) => searchBar(page).locator('[data-testid="search-match-count"]');

// ---------------------------------------------------------------------------
// 1. Open / close search bar
// ---------------------------------------------------------------------------

test.describe('Search bar open/close', () => {
  test('Cmd+F opens search bar and focuses input', async ({ page }) => {
    await openFixture(page);
    await expect(searchBar(page)).not.toBeVisible();

    await page.keyboard.press('Meta+f');
    await expect(searchBar(page)).toBeVisible();
    await expect(searchInput(page)).toBeFocused();
  });

  test('Escape closes search bar', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await expect(searchBar(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(searchBar(page)).not.toBeVisible();
  });

  test('clicking search icon toggles search bar', async ({ page }) => {
    await openFixture(page);
    const btn = page.locator('button[title="Find in document (Cmd+F)"]');

    await btn.click();
    await expect(searchBar(page)).toBeVisible();

    await btn.click();
    await expect(searchBar(page)).not.toBeVisible();
  });

  test('Cmd+F when already open re-focuses input', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('test');

    // Click away to lose focus
    await page.locator('.prose').click();
    await expect(searchInput(page)).not.toBeFocused();

    // Cmd+F again should re-focus and select the text
    await page.keyboard.press('Meta+f');
    await expect(searchInput(page)).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// 2. Search highlighting in rendered view
// ---------------------------------------------------------------------------

test.describe('Search highlighting (rendered view)', () => {
  test('typing a query highlights matches in the document', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    // The fixture has "Section One", "Section Two", "Section Three" as headings
    const highlights = page.locator('mark.search-highlight');
    await expect(highlights).toHaveCount(3);
  });

  test('match count displays correctly', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    await expect(matchCount(page)).toHaveText('1 of 3');
  });

  test('no results shows "No results"', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('xyznonexistent');

    await expect(matchCount(page)).toHaveText('No results');
    await expect(page.locator('mark.search-highlight')).toHaveCount(0);
  });

  test('active match has distinct styling', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    const activeMarks = page.locator('mark.search-highlight-active');
    await expect(activeMarks).toHaveCount(1);
  });

  test('search is case-insensitive', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('section');

    const highlights = page.locator('mark.search-highlight');
    await expect(highlights).toHaveCount(3);
  });

  test('clearing search removes all highlights', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');
    await expect(page.locator('mark.search-highlight')).toHaveCount(3);

    await searchInput(page).fill('');
    await expect(page.locator('mark.search-highlight')).toHaveCount(0);
  });

  test('closing search bar removes highlights', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');
    await expect(page.locator('mark.search-highlight')).toHaveCount(3);

    await page.keyboard.press('Escape');
    await expect(page.locator('mark.search-highlight')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Match navigation
// ---------------------------------------------------------------------------

test.describe('Match navigation', () => {
  test('Enter advances to next match', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    await expect(matchCount(page)).toHaveText('1 of 3');

    await page.keyboard.press('Enter');
    await expect(matchCount(page)).toHaveText('2 of 3');

    await page.keyboard.press('Enter');
    await expect(matchCount(page)).toHaveText('3 of 3');
  });

  test('Shift+Enter goes to previous match', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    await page.keyboard.press('Enter');
    await expect(matchCount(page)).toHaveText('2 of 3');

    await page.keyboard.press('Shift+Enter');
    await expect(matchCount(page)).toHaveText('1 of 3');
  });

  test('navigation wraps around', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    // Go past the last match
    await page.keyboard.press('Enter'); // 2 of 3
    await page.keyboard.press('Enter'); // 3 of 3
    await page.keyboard.press('Enter'); // wraps to 1 of 3
    await expect(matchCount(page)).toHaveText('1 of 3');

    // Go before the first match
    await page.keyboard.press('Shift+Enter'); // wraps to 3 of 3
    await expect(matchCount(page)).toHaveText('3 of 3');
  });

  test('prev/next buttons work', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');

    await searchBar(page).getByTitle('Next match (Enter)').click();
    await expect(matchCount(page)).toHaveText('2 of 3');

    await searchBar(page).getByTitle('Previous match (Shift+Enter)').click();
    await expect(matchCount(page)).toHaveText('1 of 3');
  });

  test('changing query resets active index', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('Section');
    await page.keyboard.press('Enter'); // 2 of 3
    await expect(matchCount(page)).toHaveText('2 of 3');

    // Type a new query — should reset to first match
    await searchInput(page).fill('login');
    await expect(matchCount(page)).toContainText('1 of');
  });
});

// ---------------------------------------------------------------------------
// 4. Search in raw view
// ---------------------------------------------------------------------------

test.describe('Search in raw view', () => {
  test('search highlights text in raw markdown view', async ({ page }) => {
    await openFixture(page);

    // Switch to raw view
    await page.locator('button[title="View raw markdown"]').click();
    await expect(page.locator('pre')).toBeVisible();

    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('##');

    // The fixture has "## Overview", "## Section One", "## Section Two", "## Section Three"
    const highlights = page.locator('pre mark.search-highlight');
    const count = await highlights.count();
    expect(count).toBe(4);
  });

  test('raw view search navigates between matches', async ({ page }) => {
    await openFixture(page);
    await page.locator('button[title="View raw markdown"]').click();

    await page.keyboard.press('Meta+f');
    await searchInput(page).fill('##');

    await expect(matchCount(page)).toHaveText('1 of 4');

    await page.keyboard.press('Enter');
    await expect(matchCount(page)).toHaveText('2 of 4');
  });
});

// ---------------------------------------------------------------------------
// 5. Command palette integration
// ---------------------------------------------------------------------------

test.describe('Command palette integration', () => {
  test('"Find in document" command opens search bar', async ({ page }) => {
    await openFixture(page);

    await page.keyboard.press('Meta+k');
    await page.getByPlaceholder('Type a command...').fill('Find');
    await page.keyboard.press('Enter');

    await expect(searchBar(page)).toBeVisible();
    await expect(searchInput(page)).toBeFocused();
  });

  test('theme commands are available in command palette', async ({ page }) => {
    await openFixture(page);

    await page.keyboard.press('Meta+k');
    await page.getByPlaceholder('Type a command...').fill('Theme');

    await expect(page.getByText('Theme: Light')).toBeVisible();
    await expect(page.getByText('Theme: Dark')).toBeVisible();
    await expect(page.getByText('Theme: Sepia')).toBeVisible();
    await expect(page.getByText('Theme: Nord')).toBeVisible();
  });

  test('selecting a theme command changes the theme', async ({ page }) => {
    await openFixture(page);

    await page.keyboard.press('Meta+k');
    await page.getByPlaceholder('Type a command...').fill('Theme: Dark');
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-theme="dark"]')).toBeVisible();
  });
});
