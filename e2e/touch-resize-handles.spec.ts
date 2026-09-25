/**
 * Touch-driven panel resizing.
 *
 * `useResizablePanel` carried the exact mouse-only pattern #35 fixed for the
 * anchor drag handles: `onMouseDown` plus `mousemove`/`mouseup` on the
 * window. iOS synthesises a `mousedown` on tap, so the explorer divider and
 * the mermaid panel splitter highlighted on touch and appeared to start a
 * drag, then received no `mousemove` for the rest of the gesture. No error
 * and nothing on screen to say the interaction was dead, exactly the failure
 * #35 documented for the anchor handles.
 *
 * Driven through CDP `Input.dispatchTouchEvent` rather than dispatched DOM
 * events, for the same reason `e2e/touch-drag-handles.spec.ts` is: #33 found
 * that synthetic pointer-event tests pass even with the touch handlers
 * deleted, so a suite that never puts a real touch through the browser's
 * input pipeline proves nothing about a touch feature. This is the real
 * pipeline; the browser derives the pointer events from it exactly as it
 * does for a finger.
 */
import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FORMATTED_DOC_BASELINE } from './helpers/fixture-baselines';
import { clearPersistedPreferences, resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/formatted-doc.md');
const MERMAID_FIXTURE = resolve(__dirname, 'fixtures/mermaid-doc.md');
const MERMAID_MARKDOWN = `# Diagram

\`\`\`mermaid
flowchart TD
  Login[Login] --> Dashboard[Dashboard]
  Dashboard --> Profile[Profile]
\`\`\`

Some prose after the diagram.
`;

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FORMATTED_DOC_BASELINE);
  writeFileSync(MERMAID_FIXTURE, MERMAID_MARKDOWN);
  await resetTestAppState(page);
});

test.afterAll(() => {
  writeFileSync(FIXTURE, FORMATTED_DOC_BASELINE);
  writeFileSync(MERMAID_FIXTURE, MERMAID_MARKDOWN);
  clearPersistedPreferences();
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

/** Open the mermaid fixture's diagram in the fullscreen modal, panel docked. */
async function openMermaidFullscreen(page: Page) {
  await page.goto(`/?file=${MERMAID_FIXTURE}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await page.locator('.mermaid-block .mermaid-svg svg').first().waitFor({ timeout: 15_000 });

  const block = page.locator('.mermaid-block').first();
  await block.hover();
  const expandBtn = block.locator('.mermaid-block-expand');
  await expect(expandBtn).toBeVisible({ timeout: 5_000 });
  await expandBtn.click();
  await expect(page.locator('.mermaid-fullscreen-modal')).toBeVisible({ timeout: 5_000 });
}

/** Press a finger on the middle of a divider and return where it landed. */
async function touchStartDivider(cdp: CDPSession, divider: Locator) {
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  return { x, y };
}

/** Move the in-progress touch to `startX + dx` for each `dx`, one event per step. */
async function touchMoveBy(cdp: CDPSession, startX: number, y: number, deltas: number[]) {
  for (const dx of deltas) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX + dx, y }],
    });
  }
}

async function panelWidth(panel: Locator): Promise<number> {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
}

test.describe('Panel resize dividers by touch', () => {
  test.use({ hasTouch: true });

  test('the hit target is 25px wide on a touch-first device', async ({ page }) => {
    await openFixture(page);
    const box = await page.locator('.resize-divider .resize-hit').boundingBox();
    expect(box?.width).toBe(25);
  });

  test('a touch drag on the explorer divider changes the explorer width', async ({ page }) => {
    await openFixture(page);
    const panel = page.locator('[data-sidebar-panel]');
    const before = await panelWidth(panel);

    const divider = page.locator('.resize-divider');
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartDivider(cdp, divider);

    // Explorer is a left-edge panel: it grows when dragged rightward.
    // Several moves, the way a finger travels; one jump would also work, but
    // the bug being guarded is that no move arrives at all.
    await touchMoveBy(cdp, x, y, [30, 60, 90]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(before);
    expect(await panelWidth(panel)).toBeGreaterThan(before);
  });

  test('a touch drag on the mermaid splitter changes its panel size', async ({ page }) => {
    await openMermaidFullscreen(page);
    const panel = page.locator('[data-mermaid-panel]');
    const before = await panelWidth(panel);

    const divider = page.locator('.mermaid-fullscreen-modal .resize-divider');
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartDivider(cdp, divider);

    // The mermaid panel sits on the right edge: it grows when dragged
    // leftward, the mirror image of the explorer above.
    await touchMoveBy(cdp, x, y, [-30, -60, -90]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(before);
    expect(await panelWidth(panel)).toBeGreaterThan(before);
  });

  test('a touchCancel mid-drag reverts the width and leaves the hook idle', async ({ page }) => {
    // touchcancel has no mouse equivalent, so nothing else in this file
    // covers it. The system fires it when a palm lands, an edge swipe
    // starts, or the browser reclaims the gesture for scrolling. A gesture
    // taken away was not a choice, so the width goes back to where it began,
    // later moves do nothing, and the hook is not stuck mid-drag.
    await openFixture(page);
    const panel = page.locator('[data-sidebar-panel]');
    const before = await panelWidth(panel);

    const divider = page.locator('.resize-divider');
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await touchStartDivider(cdp, divider);
    await touchMoveBy(cdp, x, y, [30, 60]);

    // The move has to have taken effect before cancelling, or this test
    // passes even with pointercancel handling deleted outright: the point is
    // that resizing STOPS on cancel, not that it never started.
    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(before);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

    // Back where the drag began.
    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).toBe(before);

    // (CDP will not send a touch move after a cancel, so "later moves do
    // nothing" is shown by the revert itself: without the cancel handling the
    // width stays wherever the drag left it.)
    const afterCancel = await panelWidth(panel);

    // And the hook is idle rather than stuck mid-drag: a later mouse drag on
    // the same divider still works, dragging further in the same direction.
    const box = (await divider.boundingBox())!;
    await divider.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(afterCancel);
  });

  test('the explorer divider still works with a mouse', async ({ page }) => {
    // The conversion has to keep the pointer type it already supported. This
    // is a plain regression check: a mouse drag on the explorer divider
    // still resizes it after the touch conversion.
    await openFixture(page);
    const panel = page.locator('[data-sidebar-panel]');
    const before = await panelWidth(panel);

    const divider = page.locator('.resize-divider');
    const box = (await divider.boundingBox())!;
    await divider.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(before);
    expect(await panelWidth(panel)).toBeGreaterThan(before);
  });

  test('the mermaid splitter still works with a mouse', async ({ page }) => {
    await openMermaidFullscreen(page);
    const panel = page.locator('[data-mermaid-panel]');
    const before = await panelWidth(panel);

    const divider = page.locator('.mermaid-fullscreen-modal .resize-divider');
    const box = (await divider.boundingBox())!;
    await divider.hover();
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => panelWidth(panel), { timeout: 5_000 }).not.toBe(before);
    expect(await panelWidth(panel)).toBeGreaterThan(before);
  });
});

test.describe('Panel resize dividers with a mouse', () => {
  test('keep their narrow hit target, so a mouse can still reach the pane edges', async ({
    page,
  }) => {
    // A full-height 25px strip over both panes would take the explorer's
    // scrollbar edge and clicks near the seam away from a mouse.
    await openFixture(page);
    const box = await page.locator('.resize-divider .resize-hit').boundingBox();
    expect(box?.width).toBe(9);
  });

  test("the divider's own line is grabbable with a mouse, not only its left pad", async ({
    page,
  }) => {
    await openFixture(page);
    const box = (await page.locator('.resize-divider').boundingBox())!;
    const hit = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.resize-divider')),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toBe(true);
  });

  test('a mouse drag on a divider keeps focus in the field being edited', async ({ page }) => {
    // The old mouse hook cancelled mousedown to keep focus where it was; the
    // pointer version keeps it by cancelling pointerdown. Without that, the
    // press would blur whatever field the reader was typing in.
    await openFixture(page);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'focus-probe';
      document.body.appendChild(input);
      input.focus();
    });
    const box = (await page.locator('.resize-divider').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('focus-probe');
  });
});
