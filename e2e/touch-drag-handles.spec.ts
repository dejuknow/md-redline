/**
 * Re-anchoring a comment by touch.
 *
 * Creating a comment already worked from a tablet; adjusting an existing one
 * did not. The handles were wired to `onMouseDown` with `mousemove`/`mouseup`
 * on the document, and iOS synthesises a `mousedown` on tap, so the handle
 * highlighted and the drag appeared to start and then nothing moved, with no
 * error and nothing on screen to say the interaction was dead.
 *
 * Driven through CDP touch input rather than dispatched DOM events on purpose.
 * #33 found that its synthetic-pointer tests passed with the touch handlers
 * deleted, so a suite that never puts a real touch through the browser's input
 * pipeline proves nothing about a touch feature. `Input.dispatchTouchEvent` is
 * the real pipeline: the browser derives the pointer events from it, exactly as
 * it does for a finger.
 */
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FORMATTED_DOC_BASELINE } from './helpers/fixture-baselines';
import { addComment } from './helpers/comments';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/formatted-doc.md');

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FORMATTED_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FORMATTED_DOC_BASELINE);
  clearPersistedPreferences();
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

function getCard(page: Page, commentText: string) {
  return page.locator('.group.rounded-lg', { hasText: commentText });
}

/** Put a comment on screen with its handles showing. */
async function commentWithHandles(page: Page, anchor: string, text: string) {
  await openFixture(page);
  await addComment(page, anchor, text);
  const card = getCard(page, text);
  await card.click();
  await expect(page.locator('[data-drag-handle]')).toHaveCount(2);
  return card;
}

async function anchorQuote(card: ReturnType<typeof getCard>): Promise<string> {
  const raw = await card.locator('[data-anchor-quote]').first().textContent();
  return raw?.replace(/["“”]/g, '').trim() ?? '';
}

/** Press a finger on the start handle and return where it landed. */
async function touchStartHandle(page: Page, cdp: CDPSession) {
  const box = await page.locator('[data-drag-handle]').first().boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  return { x, y };
}

test.describe('Anchor drag handles by touch', () => {
  test.use({ hasTouch: true });

  test('a touch drag moves the anchor', async ({ page }) => {
    const card = await commentWithHandles(page, 'followed by regular text', 'Touch drag test');
    const before = await anchorQuote(card);

    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartHandle(page, cdp);

    // Several moves, the way a finger travels. One jump would also work, but
    // the bug being guarded is that no move arrives at all.
    for (const step of [40, 120, 220, 300]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - step, y }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(page.locator('mark.comment-highlight').first()).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => anchorQuote(card), { timeout: 5_000 }).not.toBe(before);
    expect((await anchorQuote(card)).length).toBeGreaterThan(before.length);
  });

  test('a cancelled touch drag reverts and lets go', async ({ page }) => {
    // touchcancel has no mouse equivalent, so nothing else in the suite covers
    // this path. The system fires it when a palm lands, an edge swipe starts,
    // or the browser reclaims the gesture for scrolling. Nothing was released,
    // so committing the half-finished anchor would write an edit the reader
    // never completed, and failing to detach would leave the page stuck in a
    // drag it cannot end.
    const card = await commentWithHandles(page, 'followed by regular text', 'Touch cancel test');
    const before = await anchorQuote(card);

    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartHandle(page, cdp);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 200, y }],
    });

    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('anchor-dragging')))
      .toBe(true);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

    // Released: the class is the hook's own record that a drag is in progress.
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('anchor-dragging')), {
        timeout: 5_000,
      })
      .toBe(false);
    // And reverted, not committed.
    expect(await anchorQuote(card)).toBe(before);
  });

  test('the handles still work with a mouse', async ({ page }) => {
    // The conversion has to keep the pointer type it already supported. This is
    // the same gesture drag-regression.spec.ts drives, kept here so a touch
    // change that breaks the mouse fails in the file that made it.
    const card = await commentWithHandles(page, 'followed by regular text', 'Mouse still works');
    const before = await anchorQuote(card);

    const handle = page.locator('[data-drag-handle]').first();
    const box = await handle.boundingBox();
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(box!.x - 300, box!.y + box!.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => anchorQuote(card), { timeout: 5_000 }).not.toBe(before);
  });
});
