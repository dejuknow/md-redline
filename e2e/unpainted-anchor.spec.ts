import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertComment } from '../src/lib/comment-parser';
import { resetTestAppState } from './helpers/test-state';
import { addComment } from './helpers/comments';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');

// The anchor lives inside an HTML comment, which the renderer drops entirely
// with "Render HTML comments" off (see e2e/html-comments.spec.ts): the text is
// real in the file but never reaches the DOM. That is the exact gap #99 is
// about. A reader cannot select text that never renders, but an agent can
// anchor on it through mdr_comment, since the server validates anchors
// against the file, not the render; insertComment below is that same call.
const ANCHOR_TEXT = 'todo: fix this later';
const DOC = `# Notes

<!-- ${ANCHOR_TEXT} -->

Body text after the comment.
`;

/** A document with nothing unusual in it, for the plain regression check below. */
const PLAIN_DOC = `# Notes

A plain paragraph with ordinary text in it.
`;

let fixtureDir = '';
let fixturePath = '';

test.use({ viewport: { width: 1700, height: 950 } });

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `unpainted-anchor-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'notes.md');

  await resetTestAppState(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

/**
 * Write the marker directly into the file the way mdr_comment does
 * server-side (server/routes/review-sessions.ts calls this same insertComment
 * with the same 'Agent' default author), rather than going through the UI,
 * which could never select this text in the first place.
 */
function writeOrphanFixture() {
  const raw = insertComment(
    DOC,
    ANCHOR_TEXT,
    'Confirm this still applies before merging.',
    'Agent',
    undefined,
    undefined,
    undefined,
    undefined,
    { agentInitiated: true },
  );
  expect(raw).not.toBe(DOC); // sanity check: insertComment found the anchor and inserted a marker
  writeFileSync(fixturePath, raw);
}

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });
}

/** Enable a boolean setting via the Settings panel toggle. */
async function toggleSetting(page: Page, settingName: string) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  await panel.locator('label', { hasText: settingName }).locator('button[role="switch"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

test.describe('A margin card whose anchor is in the file but not the render (#99)', () => {
  test('the anchored rail reveals the card, with the anchor-missing treatment, instead of hiding it forever', async ({
    page,
  }) => {
    writeOrphanFixture();
    await openFixture(page);
    // renderHtmlComments defaults on, so turn it off: the state the bug
    // report describes, and the one under which HTML comments never reach
    // the DOM at all.
    await toggleSetting(page, 'Render HTML comments');

    const card = page.locator('[data-margin-card-id]');
    await expect(card).toHaveCount(1);
    // Before the fix this never becomes visible: the reveal gate had no
    // signal that would ever resolve for it, so it stayed at
    // `visibility: hidden` forever.
    await expect(card).toBeVisible();
    await expect(card).toContainText('Confirm this still applies before merging.');

    // Same orphan treatment a genuinely missing anchor gets, so the reader
    // knows to go find and re-anchor it rather than assuming it is fine.
    await expect(card.getByText('Changed')).toBeVisible();

    // No mark ever painted for this anchor (that is the whole bug), so the
    // rail has nothing to connect the card to.
    await expect(page.locator('mark.comment-highlight')).toHaveCount(0);
  });

  test('a normal comment still reveals its card at its anchor, not at the top of the rail first', async ({
    page,
  }) => {
    // A plain document with no orphan and no dropped HTML comment: this
    // regression check is about the `placed` gate itself, not about how the
    // rail stacks an orphan block above anchored cards (a real but unrelated
    // behavior of resolveCollisions). unpaintedAnchors must stay out of the
    // way of the ordinary case, where every anchor paints on the first pass.
    writeFileSync(fixturePath, PLAIN_DOC);
    await openFixture(page);

    await addComment(page, 'A plain paragraph', 'A normal margin note');

    const normalCard = page.locator('[data-margin-card-id]', { hasText: 'A normal margin note' });
    await expect(normalCard).toBeVisible();

    const markBox = await page.locator('mark.comment-highlight').first().boundingBox();
    const cardBox = await normalCard.boundingBox();
    expect(markBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(Math.abs(cardBox!.y - markBox!.y)).toBeLessThanOrEqual(24);
  });
});
