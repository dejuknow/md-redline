import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEST_DOC_BASELINE } from './helpers/fixture-baselines';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');
let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `touch-selection-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'test-doc.md');
  writeFileSync(fixturePath, TEST_DOC_BASELINE);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
}

// Create a DOM selection the way a touch gesture leaves it: a pointerdown
// with pointerType 'touch' followed by a programmatic range selection and NO
// mouseup — native touch selection never fires one. The browser fires
// selectionchange itself when the range is added.
async function selectTextViaPointer(page: Page, text: string, pointerType: string) {
  await page.evaluate(
    ({ targetText, pt }) => {
      const prose = document.querySelector('.prose') || document.body;
      prose.dispatchEvent(new PointerEvent('pointerdown', { pointerType: pt, bubbles: true }));
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.indexOf(targetText) ?? -1;
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + targetText.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          node.parentElement?.scrollIntoView({ block: 'nearest' });
          return;
        }
      }
      throw new Error(`Text "${targetText}" not found in rendered markdown`);
    },
    { targetText: text, pt: pointerType },
  );
}

test.describe('Touch selection', () => {
  // The comment surface is one pill for both modalities. What distinguishes
  // "not opened yet" from "opened" is expansion (the textarea), not the pill's
  // presence, so these assert against the textarea rather than the pill's
  // container.
  const pill = (page: Page) => page.getByTestId('pending-selection-commit');
  const textarea = (page: Page) => page.locator('[data-comment-form] textarea');

  test('touch selection shows the pill without expanding it', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');

    await expect(pill(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveCount(0);
  });

  test('adjusting the selection keeps it collapsed and the pill up', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    // Simulate handle adjustment: re-select a wider region, still no mouseup.
    await selectTextViaPointer(page, 'valid credentials to access', 'touch');
    await expect(pill(page)).toBeVisible();
    await expect(textarea(page)).toHaveCount(0);
  });

  test('tapping Comment commits the pending selection and opens the field', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    await pill(page).click();
    await expect(textarea(page)).toBeVisible({ timeout: 5000 });
    // The pill's Comment button is replaced by the expanded form.
    await expect(pill(page)).toHaveCount(0);
  });

  // Touch used to get a bare Comment button with no templates while mouse got
  // the full pill. Asserts the actual labels and that tapping one prefills the
  // composer: an earlier version of this test counted buttons, which the
  // always-present overflow control satisfied even with zero templates
  // rendered, so it passed through the exact regression it names.
  test('the quick templates are available on touch, same as mouse', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    const agreed = page.locator('[data-comment-form] button', { hasText: /^Agreed$/ });
    await expect(agreed).toBeVisible();
    await expect(
      page.locator('[data-comment-form] button', { hasText: /^Rewrite this$/ }),
    ).toBeVisible();

    // Tapping a template commits the pending selection and prefills the form.
    await agreed.click();
    await expect(textarea(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveValue(/Agreed with this/);
  });

  test('pen selections use the pending flow too', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'pen');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveCount(0);
  });

  test('collapsing the selection hides the pill', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }),
      );
      window.getSelection()?.removeAllRanges();
    });
    await expect(pill(page)).toHaveCount(0, { timeout: 5000 });
  });

  // Quick comment skips the pill and opens the form straight away. That is
  // right for mouse, where mouseup means the selection is final, and wrong for
  // touch, where the user may still be dragging the native handles. Regression
  // guard: onLock commits the pending selection, and a mount-time onLock under
  // quick comment used to fire it immediately.
  test('quick comment does not auto-open the form on a pending touch selection', async ({
    page,
  }) => {
    const home = resolve(__dirname, '..', '.playwright-home');
    const prefs = resolve(home, '.md-redline.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(prefs, JSON.stringify({ settings: { quickComment: true } }));
    try {
      await openFixture(page);
      await selectTextViaPointer(page, 'valid credentials', 'touch');
      await expect(pill(page)).toBeVisible({ timeout: 5000 });
      await expect(textarea(page)).toHaveCount(0);

      // Committing from the pill then honours quick comment as usual.
      await pill(page).click();
      await expect(textarea(page)).toBeVisible({ timeout: 5000 });
    } finally {
      rmSync(prefs, { force: true });
    }
  });

  // An iPad with a keyboard attached is the flagship setup for this feature, so
  // Cmd+Enter has to work on a touch selection. It used to no-op: the shortcut
  // gated on a ref that mirrored the committed selection only, and a touch
  // selection is pending until the user commits it.
  test('Cmd+Enter opens the form on a pending touch selection', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'touch');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(textarea(page)).toBeVisible({ timeout: 5000 });
  });

  test('mouse selection still opens the pill on mouseup, unchanged', async ({ page }) => {
    await openFixture(page);
    await selectTextViaPointer(page, 'valid credentials', 'mouse');
    // Mouse flow: fire the mouseup that ends a drag-select.
    await page.evaluate(() => {
      const sel = window.getSelection()!;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      sel.anchorNode?.parentElement?.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    // Mouse reaches the same pill, collapsed, without going through the
    // pending flow at all.
    await expect(pill(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Real touch events.
//
// Everything above drives synthetic PointerEvents and Playwright mouse clicks,
// which is the only way to model a native handle drag (the OS owns it). But it
// means the three onTouchEnd + preventDefault handlers on the pill had no
// coverage at all: they exist because on touch the synthesized mousedown
// arrives after the selection has already collapsed, and deleting them left the
// suite green. These tests tap through page.touchscreen, which dispatches real
// touchstart/touchend.
// ---------------------------------------------------------------------------
test.describe('Touch selection (real touch events)', () => {
  test.use({ hasTouch: true });

  const pill = (page: Page) => page.getByTestId('pending-selection-commit');
  const textarea = (page: Page) => page.locator('[data-comment-form] textarea');

  /** Real touch tap at an element's centre. */
  async function tap(page: Page, locator: ReturnType<Page['locator']>) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('element has no bounding box');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  }

  async function touchSelect(page: Page, text: string) {
    // A real tap first, so lastPointerType comes from a genuine touch
    // pointerdown rather than a synthesized one.
    const prose = page.locator('.prose');
    await tap(page, prose);
    await page.evaluate((needle) => {
      const root = document.querySelector('.prose')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const i = (n.textContent || '').indexOf(needle);
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + needle.length);
          const s = getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
          return;
        }
      }
      throw new Error(`"${needle}" not found`);
    }, text);
  }

  test('a real tap on Comment opens the form', async ({ page }) => {
    await openFixture(page);
    await touchSelect(page, 'valid credentials');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    await tap(page, pill(page));
    await expect(textarea(page)).toBeVisible({ timeout: 5000 });
  });

  test('a real tap on a quick template prefills the form', async ({ page }) => {
    await openFixture(page);
    await touchSelect(page, 'valid credentials');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    await tap(page, page.locator('[data-comment-form] button', { hasText: /^Agreed$/ }));
    await expect(textarea(page)).toBeVisible({ timeout: 5000 });
    await expect(textarea(page)).toHaveValue(/Agreed with this/);
  });

  test('a real tap on the overflow control opens it once, not twice', async ({ page }) => {
    await openFixture(page);
    await touchSelect(page, 'valid credentials');
    await expect(pill(page)).toBeVisible({ timeout: 5000 });

    // handlePillOverflow toggles. If preventDefault fails to suppress the
    // synthesized click, it fires twice and the menu closes again immediately.
    await tap(page, page.locator('[data-comment-form] button', { hasText: '⋯' }));
    await expect(
      page.locator('[data-comment-form] button', { hasText: /^Add detail$/ }),
    ).toBeVisible({ timeout: 5000 });
  });
});
