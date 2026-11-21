import type { BrowserContext } from '@playwright/test';

/**
 * Let the page read and write the clipboard. Chromium needs both permissions.
 * Playwright's WebKit rejects `clipboard-write` as unknown and allows writes
 * without it, so it is granted only the read.
 */
export async function grantClipboard(context: BrowserContext, browserName: string): Promise<void> {
  await context.grantPermissions(
    browserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'],
  );
}
