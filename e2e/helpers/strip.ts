import { expect, type Page } from '@playwright/test';

/**
 * The document strip keeps diff and copy in a menu (the "⋯" button, or
 * "View" when the strip is narrow), and the comment layout, prev/next and
 * bulk actions in the comments button's chevron menu. These open them.
 */

export async function openViewMenu(page: Page) {
  const button = page.locator('[data-doc-strip]').getByRole('button', { name: 'View options' });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const menu = page.getByRole('menu', { name: 'View options' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Clicks the strip's diff item ("Show diff" or "Hide diff"). */
export async function toggleDiffFromMenu(page: Page) {
  const menu = await openViewMenu(page);
  await menu.getByRole('menuitemcheckbox').click();
}

export async function copyDocumentFromMenu(page: Page) {
  const menu = await openViewMenu(page);
  await menu.getByTestId('copy-button').click();
}

export async function openCommentOptions(page: Page) {
  const button = page.locator('[data-rail-actions]');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const menu = page.getByRole('menu', { name: 'Comment options' });
  await expect(menu).toBeVisible();
  return menu;
}

export async function setRailDensity(page: Page, density: 'anchored' | 'list') {
  const menu = await openCommentOptions(page);
  await menu.locator(`[data-rail-density="${density}"]`).click();
}
