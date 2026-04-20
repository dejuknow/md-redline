// ============================================================================
// DEMO RECORDING — SETTLED DECISIONS. Please read before adding new behavior.
// ============================================================================
// - Zoom is intentionally OFF. Body scale pans off-center content during
//   zoom-out AND miscomputes drag-handle positions. Form-only scale read
//   as "no zoom" visually. Don't re-add without a new idea that avoids both.
// - Screenshots MUST be JPEG. PNG encoding stalls the test event loop ~90ms
//   per frame, which silently compresses the video's apparent timing by ~20%.
// - Submit click must use mouse.down + waitForTimeout(>=440ms) + mouse.up,
//   NOT submitBtn.click(). Otherwise the form unmounts before the blue
//   click ripple is visible and the click reads as happening on nothing.
// - After getTextBounds, wait two rAFs + 80ms before moving the mouse.
//   Layout reflows for a frame or two after a smooth-scroll, and stale
//   bounds put the cursor one line below the target text.
// - Drag handle positions inside useDragHandles are cached; after any
//   transition that might have moved the activeComment, dispatch a resize
//   event a few times to force a recompute.
// ============================================================================

import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { writeFile as writeFileAsync } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BEFORE = resolve(__dirname, 'fixtures/sample-before.md');
const DEMO_FILE = resolve(__dirname, '..', 'demo-sample.md');
const FRAMES_DIR = resolve(__dirname, 'frames');
const WALLPAPER = resolve(__dirname, 'assets/background.png');

// ----------------------------------------------------------------------------
// Timing constants. Tuned across many iterations — each has a reason. Tweak
// here, not inline. Scatter new magic numbers in the code and the next person
// to trim duration will quietly undo hard-won pacing.
// ----------------------------------------------------------------------------
//
// Total video target: 30-32s. Breakdown:
//   clip-01 CLI prompt      ~6.3s  (demo-terminal-1.tape)
//   clip-02 MDR review      ~18s   (this file)
//   clip-03 CLI resume      ~3.0s  (demo-terminal-2.tape)
//   clip-04 MDR diff view   ~6.2s  (this file)
//   crossfades              -1.5s  (3 × 0.5s)
//
// Tape-controlled timings (NOT in this file):
//   - Typing speed (CLI):   both tapes Set TypingSpeed 14ms — user asked
//                           for readable-but-not-dragging CLI typing.
//   - Clip-01 tail hold:    1.5s after "Waiting for review in md-redline...".
//                           Matches the clip-03 tail so both CLI→MDR cuts
//                           feel the same.
//   - Clip-03 tail hold:    3.3s total. review_mode prints ~2s of content,
//                           leaving ~1.3s on "Both comments addressed..."
//                           before the xfade. DON'T grow this — user asked
//                           to match clip-01 transition.
//   - mock-claude.sh review_mode starts with sleep 1.5s so the CLI doesn't
//                           burst into text the instant we cut to it —
//                           viewers need a moment to see the waiting state.

const T = {
  // MDR just opened. "Ta-da" dwell. User explicitly asked for this beat.
  MDR_INITIAL_DWELL: 2700,

  // Between comments — brief breath after the form closes.
  POST_COMMENT_HOLD: 260,

  // Smooth-scroll duration + settle wait before reading text bounds.
  // Post-scroll MUST wait long enough that layout has converged — stale
  // bounds put the cursor one line below the target text.
  SMOOTH_SCROLL: 500,
  POST_SCROLL_SETTLE: 240,

  // Cursor glide to anchor before drag starts. Visible motion, not a snap.
  CURSOR_TO_ANCHOR: 380,
  PRE_DRAG_PAUSE: 140,

  // The visible drag across the highlighted text. User specifically asked
  // for this to be slow enough to follow — don't drop below 600ms.
  DRAG_DURATION: 750,

  // After drag, before the form animates in.
  POST_DRAG: 200,

  // Form settle before measuring its bounding box.
  POST_FORM_OPEN: 140,

  // Cursor glide into the input, then dwell so viewers see focus land
  // before typing begins. User asked for the "land + breath" beat.
  CURSOR_TO_INPUT: 220,
  PRE_INPUT_CLICK: 100,
  POST_INPUT_CLICK: 260,

  // Type cadence inside the comment input. Balances readability vs pace.
  TYPE_DELAY: 15,

  // After typing, before cursor heads to submit.
  POST_TYPE: 220,

  // Cursor glide to the submit button.
  CURSOR_TO_SUBMIT: 260,
  PRE_SUBMIT_CLICK: 110,

  // The submit click is SPLIT: mouse.down fires the ripple while the
  // button is still on screen, we hold, then mouse.up triggers submit.
  // Must be >=440ms or the ripple is visible on the doc behind the
  // unmounted form, not on the button.
  SUBMIT_RIPPLE_DWELL: 440,

  // Cursor glide to "Send & finish".
  CURSOR_TO_SEND: 340,
  PRE_SEND_CLICK: 120,

  // After clicking Send & finish, before the clip ends (and xfades to
  // CLI). Must be >= 1.3s so the click is clearly visible pre-xfade.
  POST_SEND_HOLD: 1800,

  // Clip-04: dwell on the toast before moving, and the various holds
  // between diff actions.
  TOAST_DWELL: 700,
  CURSOR_TO_VIEWDIFF: 340,
  POST_VIEWDIFF_CLICK: 440,
  SMOOTH_SCROLL_DIFF: 450,
  FIRST_DIFF_HOLD: 650,
  CURSOR_TO_NEXT: 300,
  NEXT_DIFF_HOLD: 800,
  CURSOR_TO_HIDEDIFF: 260,
  CURSOR_PARK: 220,
  FINAL_HOLD: 550,
};

// ---------------------------------------------------------------------------
// Lossless screenshot capture
// ---------------------------------------------------------------------------

function startScreenCapture(page: Page, clipName: string) {
  const clipDir = resolve(FRAMES_DIR, clipName);
  rmSync(clipDir, { recursive: true, force: true });
  mkdirSync(clipDir, { recursive: true });

  let frameCount = 0;
  let running = true;
  const startTime = performance.now();
  let endTime = 0;
  const pendingWrites: Promise<void>[] = [];

  const capture = async () => {
    while (running) {
      try {
        // JPEG at q=95 — encoding is 4-6x faster than PNG on a 1600x1000
        // frame, which is the difference between ~90ms/frame (PNG stalls
        // the test's event loop via screenshot completion and doubles the
        // clip's wall-clock duration) and ~20ms/frame (imperceptible).
        const buffer = await page.screenshot({ type: 'jpeg', quality: 95 });
        const name = `frame_${String(frameCount).padStart(6, '0')}.jpg`;
        pendingWrites.push(writeFileAsync(resolve(clipDir, name), buffer));
        frameCount++;
      } catch {
        // Page might be navigating, skip frame
      }
    }
    endTime = performance.now();
  };

  const capturePromise = capture();

  return {
    async stop() {
      running = false;
      await capturePromise;
      await Promise.all(pendingWrites);
      const durationMs = endTime - startTime;
      // Record observed capture rate so record.sh stitches at the matching
      // input framerate (playback = wall-clock).
      const fps = (frameCount / (durationMs / 1000)).toFixed(3);
      writeFileSync(resolve(clipDir, 'fps.txt'), fps);
      return frameCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Page setup: wallpaper, window chrome, fake cursor, click ripples
// ---------------------------------------------------------------------------

async function setupDemoPage(page: Page) {
  // Serve the wallpaper file from demo/assets via Playwright's route handler
  await page.route('**/demo-wallpaper.png', async (route) => {
    const buffer = readFileSync(WALLPAPER);
    await route.fulfill({ body: buffer, contentType: 'image/png' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('theme', 'nord');

    // The Toast component auto-dismisses after 5s via setTimeout(_, 5000).
    // That's too short for a demo: the file-change toast with "View diff"
    // action has to stay visible long enough for the viewer to read it
    // AND for the cursor to slow-move to the button. Extend any 5000ms
    // timeout to 30000ms so the toast sticks around long enough for the
    // demo's pace. (Only affects the demo; production code is unchanged.)
    const __origSetTimeout = window.setTimeout.bind(window);
    (window as unknown as { setTimeout: typeof window.setTimeout }).setTimeout = ((
      cb: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      return __origSetTimeout(cb as TimerHandler, ms === 5000 ? 30000 : ms, ...(args as []));
    }) as typeof window.setTimeout;

    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `
        /* Body becomes the full-frame wallpaper canvas (1600x1000).
           Window is 1440x840 with equal 80px padding on all sides. */
        html, body {
          margin: 0;
          padding: 0;
          width: 1600px;
          height: 1000px;
          overflow: hidden;
          background-image: url('/demo-wallpaper.png');
          background-size: cover;
          background-position: center;
        }

        /* Window chrome (title bar) */
        #demo-chrome {
          position: absolute;
          top: 80px;
          left: 80px;
          width: 1440px;
          height: 40px;
          background: #232730;
          border-radius: 12px 12px 0 0;
          display: flex;
          align-items: center;
          padding: 0 14px;
          z-index: 999997;
          user-select: none;
          box-sizing: border-box;
        }
        #demo-chrome .dots { display: flex; gap: 8px; }
        #demo-chrome .dots span { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
        #demo-chrome .close { background: #FF5F56; }
        #demo-chrome .minimize { background: #FFBD2E; }
        #demo-chrome .maximize { background: #27C93F; }
        #demo-chrome .title {
          flex: 1; text-align: center;
          color: #8a919e; font-size: 13px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          margin-right: 52px;
        }

        /* The React app root becomes the window content.
           transform:translate(0) creates a containing block so any
           position:fixed children (toasts, popups) are positioned
           relative to #root, not the full 1600x1000 viewport. */
        #root {
          position: absolute !important;
          top: 120px !important;         /* 80 (pad) + 40 (chrome) */
          left: 80px !important;
          width: 1440px !important;
          height: 800px !important;      /* 1000 - 80 (pad bottom) - 120 (pad top) = 800 */
          border-radius: 0 0 12px 12px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
          transform: translate(0);
          font-size: 18.5px;
        }

        /* The comment form uses position:fixed with viewport-relative
           coordinates from getBoundingClientRect(). Because #root's transform
           makes it the containing block for fixed descendants, the form
           renders offset by #root's origin (80,120). Translate it back so
           it lands right under the highlighted text. */
        [data-comment-form] {
          transform: translate(-80px, -120px);
        }


        /* Fake cursor (Playwright video doesn't capture system cursor).
           Attached to <html>, not <body>, so body's zoom transform doesn't
           offset or scale the cursor — it stays pinned to true viewport
           coordinates regardless of app zoom state. */
        #demo-cursor {
          position: fixed;
          pointer-events: none;
          z-index: 999999;
          width: 24px;
          height: 24px;
          transform: translate(-3px, -2px);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
          transition: left 0.02s linear, top 0.02s linear;
          display: none;
        }

        /* Click ripple — blue, bold, concentric. Expands via width/height
           with equal-and-opposite margin offsets so the center stays pinned
           to the tip coordinate. Using transform: scale for growth was being
           clobbered elsewhere in the cascade; width/height animation is
           simpler and visibly correct. */
        .demo-ripple {
          position: fixed;
          box-sizing: border-box;
          border-radius: 50%;
          pointer-events: none;
          z-index: 2147483647;
          border: 4px solid rgba(64, 156, 255, 1);
          box-shadow: 0 0 28px 2px rgba(64, 156, 255, 0.9),
                      0 0 10px rgba(220, 235, 255, 0.85);
          animation: demo-ripple-anim 0.75s ease-out forwards;
        }
        @keyframes demo-ripple-anim {
          0%   { width: 14px;  height: 14px;  margin-left: -7px;  margin-top: -7px;  opacity: 1; border-width: 5px; }
          60%  {                                                                      opacity: 0.9; }
          100% { width: 96px;  height: 96px;  margin-left: -48px; margin-top: -48px; opacity: 0; border-width: 1px; }
        }

      `;
      document.head.appendChild(style);

      // Window chrome — still on body so it sits inside the window frame
      const chrome = document.createElement('div');
      chrome.id = 'demo-chrome';
      chrome.innerHTML =
        '<div class="dots">'
        + '<span class="close"></span>'
        + '<span class="minimize"></span>'
        + '<span class="maximize"></span>'
        + '</div>'
        + '<span class="title">md-redline</span>';
      document.body.appendChild(chrome);

      // Fake cursor — attached to <html>, NOT <body>. If it's under <body>
      // it inherits body's zoom transform and drifts away from the real
      // click location while we're zoomed in.
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
        + '<path d="M5 3l14 8.5-6.5 1.5-3.5 6z" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>'
        + '</svg>';
      document.documentElement.appendChild(cursor);

      // The cursor SVG is offset by translate(-3px,-2px) with the arrow tip
      // drawn at (5,3) in its 24x24 viewBox. That puts the visible tip at
      // (clientX + 2, clientY + 1). Ripples center on the tip, not the raw
      // event coordinate.
      const TIP_OFFSET_X = 2;
      const TIP_OFFSET_Y = 1;

      document.addEventListener('mousemove', (e) => {
        cursor.style.display = 'block';
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
      });

      // Click ripple. position:fixed + left/top pinned to the tip coordinate,
      // combined with the ripple's own margin-left/-top of -40px, places its
      // CENTER on the tip. The animation scales from 0.12→1 around that
      // center so it never appears to drift.
      //
      // Capture phase (3rd arg = true) so React's button handlers can't
      // stopPropagation us out of existence before the ripple is spawned.
      // Appended to <html>, NOT body, so the ripple shares a coordinate
      // system with the (also-on-html) cursor. Body is scaled during zoom,
      // so a ripple inside body would drift away from the cursor tip.
      document.addEventListener('mousedown', (e) => {
        const ripple = document.createElement('div');
        ripple.className = 'demo-ripple';
        ripple.style.left = (e.clientX + TIP_OFFSET_X) + 'px';
        ripple.style.top  = (e.clientY + TIP_OFFSET_Y) + 'px';
        document.documentElement.appendChild(ripple);
        setTimeout(() => ripple.remove(), 900);
      }, true);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Playwright's mouse.move with `steps` moves too fast for a demo video —
 *  the cursor flashes to the target. This helper animates the cursor
 *  explicitly over `durationMs` so viewers can follow the motion. */
const cursorState = { x: 800, y: 500 };

async function slowMove(page: Page, targetX: number, targetY: number, durationMs = 550) {
  const startX = cursorState.x;
  const startY = cursorState.y;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy);
  // No perceptible motion needed if we're already essentially there.
  if (distance < 3) {
    await page.mouse.move(targetX, targetY);
    cursorState.x = targetX;
    cursorState.y = targetY;
    return;
  }
  // ~55fps update cadence feels smooth without overwhelming Playwright.
  const frameMs = 18;
  const steps = Math.max(5, Math.ceil(durationMs / frameMs));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // easeInOutQuad for a natural accelerate→decelerate
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = startX + dx * eased;
    const y = startY + dy * eased;
    await page.mouse.move(x, y);
    await page.waitForTimeout(frameMs);
  }
  cursorState.x = targetX;
  cursorState.y = targetY;
}

/** Smoothly scroll the markdown scroll container so the target text lands
 *  at `targetFraction` from the top of the viewport. Animates over
 *  `durationMs` instead of snapping. */
async function smoothScrollTargetInto(
  page: Page,
  text: string,
  targetFraction = 0.25,
  durationMs = 900,
) {
  await page.evaluate(
    ({ targetText, fraction, duration }) => {
      const walker = document.createTreeWalker(
        document.querySelector('.prose') || document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.indexOf(targetText) ?? -1;
        if (idx < 0) continue;
        const el = node.parentElement;
        if (!el) return;
        let scroller: Element | null = el;
        while (scroller && getComputedStyle(scroller).overflowY === 'visible') {
          scroller = scroller.parentElement;
        }
        if (!scroller) return;
        const rect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const targetTop = scrollerRect.top + scrollerRect.height * fraction;
        const delta = rect.top - targetTop;
        const startScroll = (scroller as HTMLElement).scrollTop;
        const endScroll = startScroll + delta;

        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          // easeInOutQuad
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          (scroller as HTMLElement).scrollTop = startScroll + (endScroll - startScroll) * eased;
          if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        return;
      }
    },
    { targetText: text, fraction: targetFraction, duration: durationMs },
  );
  await page.waitForTimeout(durationMs + 60);
}

async function getTextBounds(page: Page, text: string) {
  return page.evaluate((targetText) => {
    const walker = document.createTreeWalker(
      document.querySelector('.prose') || document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.textContent?.indexOf(targetText) ?? -1;
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + targetText.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    throw new Error(`Text "${targetText}" not found`);
  }, text);
}

async function addCommentAnimated(page: Page, anchorText: string, commentText: string) {
  // Double-rAF + brief settle before reading the text bounds. Right after a
  // smooth-scroll and a previous form close, the document layout can still
  // be mid-reflow for a frame or two, which produces bounds that don't
  // match the final on-screen position. Waiting past two paint cycles is
  // enough for layout to converge.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForTimeout(80);

  const bounds = await getTextBounds(page, anchorText);

  // The fake cursor's visible tip sits 2px right / 1px below its DOM origin
  // (SVG tip at (5,3), with transform: translate(-3px, -2px)). To land the
  // tip ON the text rather than to the right and below, shift the Playwright
  // mouse coordinate back by that offset.
  const TIP_DX = 2;
  const TIP_DY = 1;
  const startX = bounds.x + 2 - TIP_DX;
  const centerY = bounds.y + bounds.height / 2 - TIP_DY;
  const endX = bounds.x + bounds.width - 2 - TIP_DX;

  // Glide the cursor over to the anchor text first so the motion reads for viewers.
  await slowMove(page, startX, centerY, T.CURSOR_TO_ANCHOR);
  await page.waitForTimeout(T.PRE_DRAG_PAUSE);

  // Drag across the anchor — visibly slow so the highlight tracks the motion.
  // The browser's native selection can extend a bit past the intended range
  // during a slow drag; we pin the final selection to exactly `anchorText`
  // via Range API before mouse.up so the form reads the correct text.
  await page.mouse.move(startX, centerY);
  await page.mouse.down();
  await slowMove(page, endX, centerY, T.DRAG_DURATION);

  // Re-pin the selection to exactly cover the anchor, independent of what
  // the browser captured during the drag. This is what the comment form
  // reads when it appears.
  await page.evaluate((targetText) => {
    const walker = document.createTreeWalker(
      document.querySelector('.prose') || document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const idx = node.textContent?.indexOf(targetText) ?? -1;
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + targetText.length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return;
      }
    }
  }, anchorText);

  await page.mouse.up();
  await page.waitForTimeout(T.POST_DRAG);

  const input = page.getByPlaceholder('Add your comment...');
  await expect(input).toBeVisible({ timeout: 5000 });

  // Let the form settle, re-read the input bounding box after it stabilizes.
  await page.waitForTimeout(T.POST_FORM_OPEN);
  const inputBox = await input.boundingBox();

  // Move to the input
  if (inputBox) {
    await slowMove(
      page,
      inputBox.x + inputBox.width / 2,
      inputBox.y + inputBox.height / 2,
      T.CURSOR_TO_INPUT,
    );
    await page.waitForTimeout(T.PRE_INPUT_CLICK);
  }
  await input.click();
  // Short dwell after clicking the input — viewers see the cursor land and
  // the field get focus before typing begins.
  await page.waitForTimeout(T.POST_INPUT_CLICK);

  // Type at a comfortable reading pace
  await page.keyboard.type(commentText, { delay: T.TYPE_DELAY });
  await page.waitForTimeout(T.POST_TYPE);

  const submitBtn = page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' });
  const submitBox = await submitBtn.boundingBox();
  if (submitBox) {
    const cx = submitBox.x + submitBox.width / 2;
    const cy = submitBox.y + submitBox.height / 2;
    await slowMove(page, cx, cy, T.CURSOR_TO_SUBMIT);
    await page.waitForTimeout(T.PRE_SUBMIT_CLICK);

    // Split the click: mouse.down() fires mousedown (and spawns the ripple
    // on the still-visible button via our document-level handler), we hold
    // so the ripple plays ON the button, then mouse.up() fires the real
    // click and triggers submit + form unmount. Without this, Playwright's
    // .click() fires mousedown+mouseup back-to-back and the form unmounts
    // before the ripple is perceptible.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(T.SUBMIT_RIPPLE_DWELL);
    await page.mouse.up();
  } else {
    await submitBtn.click();
  }
  await expect(input).not.toBeVisible({ timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Demo recording — single test to preserve localStorage (diff snapshot)
// ---------------------------------------------------------------------------

test.describe.serial('Demo recording', () => {

  test.beforeAll(() => {
    copyFileSync(FIXTURE_BEFORE, DEMO_FILE);
  });

  test('record browser clips', async ({ page, request, baseURL }) => {
    await setupDemoPage(page);

    await request.put(`${baseURL}/api/preferences`, {
      data: {
        author: 'Dennis',
        settings: {
          enableResolve: true,
          quickComment: true,
          showTemplatesByDefault: false,
        },
      },
    });

    const res = await request.post(`${baseURL}/api/review-sessions`, {
      data: { filePaths: [DEMO_FILE], enableResolve: true },
    });
    expect(res.status()).toBe(201);
    const { sessionId } = await res.json() as { sessionId: string };

    await page.goto(`/?review=${encodeURIComponent(sessionId)}`);
    await expect(page.locator('.prose')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-theme="nord"]')).toBeVisible();

    const banner = page.getByTestId('review-banner');
    await expect(banner).toBeVisible({ timeout: 12_000 });

    // =====================================================================
    // CLIP 02: Add comments and send review
    // =====================================================================
    const capture02 = startScreenCapture(page, 'clip-02');

    // Hold on the fully-opened mdr window so viewers get a "ta-da" moment to
    // absorb the UI before any motion starts.
    await page.waitForTimeout(T.MDR_INITIAL_DWELL);

    // Comment 1: password strength — smooth scroll into view, then annotate
    await smoothScrollTargetInto(page, 'Minimum 8 characters', 0.28, T.SMOOTH_SCROLL);
    await page.waitForTimeout(T.POST_SCROLL_SETTLE);
    await addCommentAnimated(page, 'Minimum 8 characters', 'Increase to 12 characters.');
    await page.waitForTimeout(T.POST_COMMENT_HOLD);

    // Comment 2: token expiry
    await smoothScrollTargetInto(page, 'valid 1 hour', 0.28, T.SMOOTH_SCROLL);
    await page.waitForTimeout(T.POST_SCROLL_SETTLE);
    await addCommentAnimated(page, 'valid 1 hour', 'Is this too short? Other suggestions?');
    await page.waitForTimeout(T.POST_COMMENT_HOLD);

    // Click "Send & finish"
    const sendBtn = banner.getByRole('button', { name: 'Send & finish' });
    const sendBox = await sendBtn.boundingBox();
    if (sendBox) {
      await slowMove(page, sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2, T.CURSOR_TO_SEND);
      await page.waitForTimeout(T.PRE_SEND_CLICK);
    }
    await sendBtn.click();
    // Hold long enough that the click clearly reads BEFORE the crossfade
    // into clip-03 starts (xfade is 0.5s, so we need the click to land well
    // before the cut).
    await page.waitForTimeout(T.POST_SEND_HOLD);

    await capture02.stop();

    // =====================================================================
    // Simulate agent edits (between clip 02 and clip 04)
    // =====================================================================

    const content = readFileSync(DEMO_FILE, 'utf-8');
    await page.evaluate((args) => {
      const snapshots = { [args.path]: args.content };
      localStorage.setItem('md-redline-snapshots', JSON.stringify(snapshots));
    }, { path: DEMO_FILE, content });

    let modified = content
      .replace(/- (<!-- @comment\{[^>]*"anchor":"Minimum 8 characters"[^>]*\} -->)Minimum 8 characters/,
        (_, marker) => {
          const updated = marker
            .replace(/\} -->$/, ',"replies":[{"id":"r1","text":"Done. Updated to 12 characters.","author":"Agent","timestamp":"2026-03-26T12:01:00.000Z"}],"resolved":true,"status":"resolved"} -->');
          return `- ${updated}Minimum 12 characters`;
        });

    modified = modified.replace(
      /(<!-- @comment\{[^>]*"anchor":"valid 1 hour"[^>]*)\} -->/,
      '$1,"replies":[{"id":"r2","text":"Good catch. Industry standard is 24 hours (AWS Cognito, Auth0, Firebase all default to this). Updated to 24 hours.","author":"Agent","timestamp":"2026-03-26T12:02:00.000Z"}]} -->',
    );

    modified = modified
      .replace(/--> -->valid 1 hour/, '--> -->valid 24 hours')
      .replace(/} -->valid 1 hour/, '} -->valid 24 hours')
      .replace(/"anchor":"valid 1 hour"/, '"anchor":"valid 24 hours"')
      .replace(
        /5\. All existing sessions are invalidated after the password change\./,
        '5. All existing sessions are invalidated after the password change.\n\nIndustry standard for password reset tokens is 24 hours (AWS Cognito,\nAuth0, and Firebase all default to this). One hour is too aggressive\nand leads to support tickets from users in different time zones.\nFor higher-security environments, consider a 6-hour window with a\none-time-use constraint instead.',
      );

    writeFileSync(DEMO_FILE, modified);

    // =====================================================================
    // CLIP 04: Show results — toast, resolved comments, diff view
    // =====================================================================

    // The toast carries a "View diff" action. Its auto-dismiss timer is
    // extended in setupDemoPage so the toast stays visible throughout the
    // clip, letting the viewer read the message and the cursor slow-move
    // to the button.
    const viewDiffBtn = page.getByRole('button', { name: 'View diff' });
    await expect(viewDiffBtn).toBeVisible({ timeout: 15_000 });

    const capture04 = startScreenCapture(page, 'clip-04');

    // Dwell on the toast so the viewer can read it before any motion starts.
    await page.waitForTimeout(T.TOAST_DWELL);

    const diffBox = await viewDiffBtn.boundingBox();
    if (diffBox) {
      await slowMove(page, diffBox.x + diffBox.width / 2, diffBox.y + diffBox.height / 2, T.CURSOR_TO_VIEWDIFF);
      await page.waitForTimeout(100);
    }
    await viewDiffBtn.click();
    await page.waitForTimeout(T.POST_VIEWDIFF_CLICK);

    // Scroll to first comment (resolved) with diff overlay visible
    await smoothScrollTargetInto(page, 'Minimum 12 characters', 0.28, T.SMOOTH_SCROLL_DIFF);
    await page.waitForTimeout(T.FIRST_DIFF_HOLD);

    const nextDiffBtn = page.getByRole('button', { name: 'Next change' });
    if (await nextDiffBtn.isVisible().catch(() => false)) {
      const nextBox = await nextDiffBtn.boundingBox();
      if (nextBox) {
        await slowMove(page, nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2, T.CURSOR_TO_NEXT);
        await page.waitForTimeout(100);
      }
      await nextDiffBtn.click();
      await page.waitForTimeout(T.NEXT_DIFF_HOLD);
    } else {
      await smoothScrollTargetInto(page, 'valid 24 hours', 0.28, T.SMOOTH_SCROLL_DIFF);
      await page.waitForTimeout(T.NEXT_DIFF_HOLD);
    }

    // Toggle diff view OFF to end on the clean final spec
    const hideDiffBtn = page.getByRole('button', { name: 'Hide diff overlay' });
    if (await hideDiffBtn.isVisible().catch(() => false)) {
      const hideBox = await hideDiffBtn.boundingBox();
      if (hideBox) {
        await slowMove(page, hideBox.x + hideBox.width / 2, hideBox.y + hideBox.height / 2, T.CURSOR_TO_HIDEDIFF);
        await page.waitForTimeout(100);
      }
      await hideDiffBtn.click();
      await slowMove(page, 400, 400, T.CURSOR_PARK);
    }

    // Hold the final clean frame so viewers absorb the finished spec
    await page.waitForTimeout(T.FINAL_HOLD);

    await capture04.stop();
  });

  test.afterAll(() => {
    if (existsSync(DEMO_FILE)) unlinkSync(DEMO_FILE);
  });
});
