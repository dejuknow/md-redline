import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/toc-doc.md');
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

/** Click the Outline tab in the left panel */
async function switchToOutline(page: Page) {
  await page.locator('button[title="Document outline"]').click();
}

/** Ensure the left panel is visible */
async function ensureLeftPanelOpen(page: Page) {
  const panel = page.locator('button[title="Document outline"]');
  if (!(await panel.isVisible())) {
    await page.locator('button[title="Toggle file explorer (Cmd+B)"]').click();
    await page.waitForTimeout(300);
  }
}

// ---------------------------------------------------------------------------
// TOC outline tests
// ---------------------------------------------------------------------------

test.describe('Table of Contents', () => {
  test('outline tab shows headings from the document', async ({ page }) => {
    await openFixture(page);
    await ensureLeftPanelOpen(page);
    await switchToOutline(page);

    await expect(page.locator('button[title="Project Specification"]')).toBeVisible();
    await expect(page.locator('button[title="Introduction"]')).toBeVisible();
    await expect(page.locator('button[title="Requirements"]')).toBeVisible();
    await expect(page.locator('button[title="Conclusion"]')).toBeVisible();
  });

  test('clicking a heading scrolls the content to that section', async ({ page }) => {
    await openFixture(page);
    await ensureLeftPanelOpen(page);
    await switchToOutline(page);

    // Record initial scroll position
    const scrollBefore = await page.evaluate(() => {
      const scrollEl = document.querySelector('.prose')?.closest('.overflow-y-auto');
      return scrollEl ? scrollEl.scrollTop : 0;
    });

    // Click a heading that's below the fold
    await page.locator('button[title="Conclusion"]').click();

    // Wait for smooth scroll to complete
    await page.waitForTimeout(600);

    // Verify scroll position changed (content scrolled down)
    const scrollAfter = await page.evaluate(() => {
      const scrollEl = document.querySelector('.prose')?.closest('.overflow-y-auto');
      return scrollEl ? scrollEl.scrollTop : 0;
    });
    expect(scrollAfter).toBeGreaterThan(scrollBefore);
  });

  test('switching between Explorer and Outline tabs', async ({ page }) => {
    await openFixture(page);
    await ensureLeftPanelOpen(page);

    // Should start on Explorer — file listing should be visible
    await expect(page.locator('button[title="File explorer"]')).toBeVisible();

    // Switch to Outline
    await switchToOutline(page);
    await expect(page.locator('button[title="Project Specification"]')).toBeVisible();

    // Switch back to Explorer
    await page.locator('button[title="File explorer"]').click();
    // Outline headings should no longer be visible
    await expect(page.locator('button[title="Project Specification"]')).not.toBeVisible();
  });

  test('duplicate headings get unique IDs', async ({ page }) => {
    await openFixture(page);

    // The fixture has two "Background" h2 headings
    const firstBg = page.locator('h2#background');
    const secondBg = page.locator('h2#background-1');
    await expect(firstBg).toBeVisible();
    await expect(secondBg).toBeVisible();
  });

  test('headings get IDs for all levels', async ({ page }) => {
    await openFixture(page);

    // h1
    await expect(page.locator('h1#project-specification')).toBeVisible();
    // h2
    await expect(page.locator('h2#introduction')).toBeVisible();
    // h3
    await expect(page.locator('h3#technical-constraints')).toBeVisible();
  });

  test('Cmd+Shift+O toggles outline view', async ({ page }) => {
    await openFixture(page);

    // Close the left panel first
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(300);

    // Cmd+Shift+O should open panel with outline
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForTimeout(300);
    await expect(page.locator('button[title="Project Specification"]')).toBeVisible();

    // Cmd+Shift+O again should close the panel
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForTimeout(300);
    await expect(page.locator('button[title="Project Specification"]')).not.toBeVisible();
  });

  test('command palette lists headings', async ({ page }) => {
    await openFixture(page);

    // Open command palette
    await page.keyboard.press('Meta+k');
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible();

    // Type a heading name to filter
    await input.fill('Conclusion');
    await page.waitForTimeout(100);

    // Should see the heading entry in the filtered list
    const headingItem = page.locator('button', { hasText: 'Conclusion' });
    await expect(headingItem.first()).toBeVisible();
  });

  test('active heading tracks scroll position', async ({ page }) => {
    await openFixture(page);
    await ensureLeftPanelOpen(page);
    await switchToOutline(page);

    // Initially scrolled to the top — first heading should be active
    const firstHeading = page.locator('button[title="Project Specification"]');
    await expect(firstHeading).toHaveClass(/bg-primary-bg/);

    // Programmatically scroll to "Implementation" heading (instant, no smooth animation)
    await page.evaluate(() => {
      const heading = document.querySelector('h2#implementation');
      if (heading) heading.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await page.waitForTimeout(200);

    // The first heading should no longer be active
    await expect(firstHeading).not.toHaveClass(/bg-primary-bg/);

    // A different heading should now be active (active tracking responded to scroll)
    // Use font-medium as a marker — only the active TOC item has it
    const activeTocItem = page.locator('button[title].font-medium.bg-primary-bg');
    await expect(activeTocItem).toBeVisible();
  });

  test('outline shows empty state when no headings', async ({ page }) => {
    // Write a file with no headings
    writeFileSync(FIXTURE, 'Just a paragraph.\n\nAnother paragraph.');

    await page.goto(`/?file=${FIXTURE}`);
    await page.locator('.prose').waitFor({ timeout: 10_000 });

    await ensureLeftPanelOpen(page);
    await switchToOutline(page);

    // Use exact text match on the empty state span
    await expect(page.getByText('No headings', { exact: true })).toBeVisible();
  });

  test('outline indentation reflects heading hierarchy', async ({ page }) => {
    await openFixture(page);
    await ensureLeftPanelOpen(page);
    await switchToOutline(page);

    // h1 should have less padding than h2, which should have less than h3
    const h1Btn = page.locator('button[title="Project Specification"]');
    const h2Btn = page.locator('button[title="Introduction"]');
    const h3Btn = page.locator('button[title="Technical Constraints"]');

    const h1Classes = await h1Btn.getAttribute('class') ?? '';
    const h2Classes = await h2Btn.getAttribute('class') ?? '';
    const h3Classes = await h3Btn.getAttribute('class') ?? '';

    // h1 gets pl-3, h2 gets pl-6, h3 gets pl-9
    expect(h1Classes).toContain('pl-3');
    expect(h2Classes).toContain('pl-6');
    expect(h3Classes).toContain('pl-9');
  });
});
