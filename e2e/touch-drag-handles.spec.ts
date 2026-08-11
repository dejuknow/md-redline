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

/**
 * Poll until two consecutive reads of both handles agree, meaning the page's
 * width transition and the rAF reposition behind it have settled. Without it a
 * boundingBox read mid-animation aims the finger at prose instead of a 4px
 * handle, which fails intermittently and for a reason that has nothing to do
 * with touch. drag-regression.spec.ts gates every mouse drag the same way.
 */
async function stableHandlePositions(page: Page): Promise<void> {
  let previous: { start: number; end: number } | null = null;
  await expect(async () => {
    const handles = page.locator('[data-drag-handle]');
    const startBox = await handles.first().boundingBox();
    const endBox = await handles.last().boundingBox();
    const current = startBox && endBox ? { start: startBox.x, end: endBox.x } : null;
    const stable =
      current !== null &&
      previous !== null &&
      current.start === previous.start &&
      current.end === previous.end;
    previous = current;
    expect(stable).toBe(true);
  }).toPass({ timeout: 2000 });
}

/** Put a comment on screen with its handles showing and settled. */
async function commentWithHandles(page: Page, anchor: string, text: string) {
  await openFixture(page);
  await addComment(page, anchor, text);
  const card = getCard(page, text);
  await card.click();
  await expect(page.locator('[data-drag-handle]')).toHaveCount(2);
  await stableHandlePositions(page);
  return card;
}

/** The live highlighted text, which moves during a drag rather than on commit. */
function highlightedText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('mark.comment-highlight-active'))
      .map((m) => m.textContent ?? '')
      .join(''),
  );
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

    const highlightBefore = await highlightedText(page);
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartHandle(page, cdp);
    for (const step of [60, 140, 220]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - step, y }],
      });
    }

    // The move has to have taken effect before cancelling, or this test passes
    // with pointermove handling deleted: `anchor-dragging` goes on at
    // pointerdown, and the card's anchor only updates on commit, so both of the
    // signals it used to check were satisfied by the press alone.
    await expect.poll(() => highlightedText(page), { timeout: 5_000 }).not.toBe(highlightBefore);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

    // Released: the class is the hook's own record that a drag is in progress.
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('anchor-dragging')), {
        timeout: 5_000,
      })
      .toBe(false);
    // And reverted, not committed: both the live highlight and the stored anchor.
    await expect.poll(() => highlightedText(page), { timeout: 5_000 }).toBe(highlightBefore);
    expect(await anchorQuote(card)).toBe(before);
  });

  test('a second finger on the other handle does not start a second drag', async ({ page }) => {
    // Both handles accept a pointerdown, so two fingers used to start two
    // drags over one shared drag state. The second overwrote the first, whose
    // listeners stayed attached, and snapshotted the already-dragged DOM as its
    // "original" so a later cancel reverted to a document that never existed.
    const card = await commentWithHandles(page, 'followed by regular text', 'Two finger test');
    const before = await anchorQuote(card);

    const cdp = await page.context().newCDPSession(page);
    const boxes = page.locator('[data-drag-handle]');
    const startBox = (await boxes.first().boundingBox())!;
    const endBox = (await boxes.last().boundingBox())!;
    const a = { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 };
    const b = { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height / 2 };

    // CDP wants ids on every point or none of them, and two fingers need them.
    const finger = { ...a, id: 0 };
    const second = { ...b, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
    // Second finger lands while the first is still down.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [finger, second],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { ...finger, x: a.x - 120 },
        { ...second, x: b.x + 120 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // One drag ran, so the anchor moved at one end only: it grew leftward and
    // kept its original ending.
    await expect.poll(() => anchorQuote(card), { timeout: 5_000 }).not.toBe(before);
    const after = await anchorQuote(card);
    expect(after.endsWith(before.slice(-12))).toBe(true);
    // And the document is left in a state the parser still reads.
    await expect(page.locator('mark.comment-highlight').first()).toBeVisible();
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
