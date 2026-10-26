import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';
import { clickCardAction, getCard, switchToListDensity } from './helpers/comments';

// A file can carry a resolved marker while the reader has the resolve workflow
// off: resolved in an earlier resolve-mode session, by an agent session started
// with it on, by a collaborator, or by hand. It is finished there too (#159),
// so every surface shows it as resolved and nothing offers a reply that Send
// would never carry. The e2e baseline (resetTestAppState) is remove mode.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

// Wide enough for the rail, so the List density is one click away.
test.use({ viewport: { width: 1700, height: 950 } });

const OPEN_TEXT = 'Still being discussed';
const RESOLVED_TEXT = 'Settled in an earlier round';

const marker = (id: string, anchor: string, text: string, status: 'open' | 'resolved') =>
  `<!-- @comment${JSON.stringify({
    id,
    anchor,
    text,
    author: 'User',
    timestamp: '2024-01-01T00:00:00.000Z',
    status,
    replies: [],
  })} -->`;

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `resolved-remove-mode-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(
    fixturePath,
    TEST_DOC_BASELINE.replace(
      'valid credentials',
      `${marker('c-open', 'valid credentials', OPEN_TEXT, 'open')}valid credentials`,
    ).replace(
      'brute force attacks',
      `${marker('c-resolved', 'brute force attacks', RESOLVED_TEXT, 'resolved')}brute force attacks`,
    ),
  );
  await resetTestAppState(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Test Document' })).toBeVisible({
    timeout: 10_000,
  });
}

// The open count is the rounded badge with a number and no title.
function openBadge(page: Page) {
  return page
    .locator('.h-11')
    .locator('button', { hasText: 'test-doc.md' })
    .first()
    .locator('span.rounded-full:not([title])', { hasText: /\d/ });
}

test.describe('A resolved marker with the resolve workflow off (#159)', () => {
  test('reads as resolved in the prose, the badge and the List view', async ({ page }) => {
    await openFixture(page);

    // A faint trace, the same as in resolve mode, not a live highlight.
    const trace = page.locator('mark.comment-highlight-resolved');
    await expect(trace).toHaveCount(1);
    await expect(trace).toHaveText('brute force attacks');

    // Only the open comment is work left.
    await expect(openBadge(page)).toHaveText('1');

    await switchToListDensity(page);
    const card = getCard(page, RESOLVED_TEXT);
    await expect(card.getByText('Resolved', { exact: true })).toBeVisible();
    await expect(page.getByText('Resolved (1)')).toBeVisible();

    // Selected, it offers Reopen and no reply field. A reply typed there would
    // never be sent, since the thread is out of the Send set.
    await card.getByText(RESOLVED_TEXT).first().click();
    await expect(
      card.locator('[data-thread-bar]').getByRole('button', { name: 'Reopen', exact: true }),
    ).toBeVisible();
    await expect(card.getByRole('button', { name: 'Write a reply...' })).toHaveCount(0);

    // The open comment's card keeps remove mode's actions: no Resolve.
    const openCard = getCard(page, OPEN_TEXT);
    await openCard.getByText(OPEN_TEXT).first().click();
    await expect(openCard.locator('[data-thread-bar]')).toBeVisible();
    await expect(
      openCard.locator('[data-thread-bar]').getByRole('button', { name: 'Resolve', exact: true }),
    ).toHaveCount(0);
  });

  test('Reopen brings the thread back as open work', async ({ page }) => {
    await openFixture(page);
    await switchToListDensity(page);

    await clickCardAction(page, RESOLVED_TEXT, 'Reopen');

    await expect(page.locator('mark.comment-highlight-resolved')).toHaveCount(0);
    await expect(openBadge(page)).toHaveText('2');
    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 5000 })
      .not.toContain('"status":"resolved"');

    // Nothing resolved is left, so remove mode's flat List view returns.
    await expect(page.getByText('2 comments')).toBeVisible();
    await expect(page.getByText(/Resolved \(\d\)/)).toHaveCount(0);
  });
});
