import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = resolve(__dirname, 'fixtures/mermaid-doc.md');
const FIXTURE_MARKDOWN = `# Diagram

\`\`\`mermaid
flowchart TD
  Login[Login] --> Dashboard[Dashboard]
  Dashboard --> Profile[Profile]
\`\`\`

Some prose after the diagram.
`;

/** Reset the fixture file to its original content. */
function resetFixture() {
  writeFileSync(FIXTURE_PATH, FIXTURE_MARKDOWN);
}

test.beforeEach(async ({ page }) => {
  resetFixture();
  await resetTestAppState(page);
});

test.afterAll(() => {
  resetFixture();
});

/** Navigate to the mermaid fixture and wait for the diagram SVG to render. */
async function openMermaidFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE_PATH}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  // Wait for mermaid SVG to be rendered inside the block
  await page.locator('.mermaid-block .mermaid-svg svg').first().waitFor({ timeout: 15_000 });
}

/** Hover over the mermaid block and click the expand button to open the modal. */
async function openFullscreenModal(page: Page) {
  const block = page.locator('.mermaid-block').first();
  await block.hover();
  const expandBtn = block.locator('.mermaid-block-expand');
  await expect(expandBtn).toBeVisible({ timeout: 5_000 });
  await expandBtn.click();
  await expect(page.locator('.mermaid-fullscreen-modal')).toBeVisible({ timeout: 5_000 });
}

/** Programmatically select a substring in SVG text and dispatch mouseup to open the composer. */
async function selectSubstringInFullscreenSvg(page: Page, labelText: string, substring: string) {
  await page.evaluate(
    ([full, needle]) => {
      const textEl = [
        ...document.querySelectorAll('.mermaid-fullscreen-canvas-inner svg text'),
      ].find((t) => (t.textContent || '').includes(full)) as SVGElement | undefined;
      if (!textEl) throw new Error(`SVG text containing "${full}" not found in fullscreen canvas`);

      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      let targetTn: Text | null = null;
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if ((node.textContent || '').includes(needle)) {
          targetTn = node;
          break;
        }
      }
      if (!targetTn) throw new Error(`"${needle}" not found in any text node of "${full}"`);

      const idx = (targetTn.textContent || '').indexOf(needle);
      const range = document.createRange();
      range.setStart(targetTn, idx);
      range.setEnd(targetTn, idx + needle.length);
      const sel = window.getSelection();
      if (!sel) throw new Error('Selection API unavailable');
      sel.removeAllRanges();
      sel.addRange(range);

      const rect = range.getBoundingClientRect();
      textEl.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );

      // selectionchange fires asynchronously; also dispatch selectionchange manually
      document.dispatchEvent(new Event('selectionchange'));
    },
    [labelText, substring] as const,
  );
}

// ---------------------------------------------------------------------------
// Test 1: Hover-button trigger opens the modal
// ---------------------------------------------------------------------------
test('hover-button opens the fullscreen modal', async ({ page }) => {
  await openMermaidFixture(page);

  const block = page.locator('.mermaid-block').first();
  await block.hover();
  const expandBtn = block.locator('.mermaid-block-expand');
  await expect(expandBtn).toBeVisible({ timeout: 5_000 });

  await expandBtn.click();

  await expect(page.locator('.mermaid-fullscreen-modal')).toBeVisible({ timeout: 5_000 });
  // The shell with the canvas and panel should be present
  await expect(page.locator('.mermaid-fullscreen-shell')).toBeVisible();
  // The SVG is rendered inside the canvas
  await expect(page.locator('.mermaid-fullscreen-canvas-inner svg')).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 2: Esc closes the modal
// ---------------------------------------------------------------------------
test('Esc closes the fullscreen modal', async ({ page }) => {
  await openMermaidFixture(page);
  await openFullscreenModal(page);

  // Ensure the canvas SVG is present before pressing Escape
  await expect(page.locator('.mermaid-fullscreen-canvas-inner svg')).toBeVisible({ timeout: 8_000 });

  await page.keyboard.press('Escape');

  await expect(page.locator('.mermaid-fullscreen-modal')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: Backdrop click closes the modal
// ---------------------------------------------------------------------------
test('clicking the backdrop closes the fullscreen modal', async ({ page }) => {
  await openMermaidFixture(page);
  await openFullscreenModal(page);

  // Click on the modal backdrop (the outer .mermaid-fullscreen-modal element),
  // not inside the .mermaid-fullscreen-shell. We use page.evaluate to dispatch
  // the click directly on the modal element itself (its center is covered by the
  // shell, so we target a corner that falls outside the shell).
  const clicked = await page.evaluate(() => {
    const modal = document.querySelector('.mermaid-fullscreen-modal') as HTMLElement | null;
    const shell = document.querySelector('.mermaid-fullscreen-shell') as HTMLElement | null;
    if (!modal || !shell) return false;

    const modalRect = modal.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();

    // Find a point inside the modal but outside the shell (the backdrop area).
    // Try left edge, then right edge, then top, then bottom.
    const candidates: { x: number; y: number }[] = [
      { x: modalRect.left + 8, y: modalRect.top + modalRect.height / 2 },
      { x: modalRect.right - 8, y: modalRect.top + modalRect.height / 2 },
      { x: modalRect.left + modalRect.width / 2, y: modalRect.top + 8 },
      { x: modalRect.left + modalRect.width / 2, y: modalRect.bottom - 8 },
    ];

    for (const { x, y } of candidates) {
      const inShell =
        x >= shellRect.left && x <= shellRect.right && y >= shellRect.top && y <= shellRect.bottom;
      if (!inShell) {
        modal.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
        );
        return true;
      }
    }
    // Fallback: dispatch directly on the modal element (React's onClick checks
    // e.target === e.currentTarget)
    modal.dispatchEvent(
      new MouseEvent('click', { bubbles: false, cancelable: true }),
    );
    return true;
  });

  expect(clicked).toBe(true);
  await expect(page.locator('.mermaid-fullscreen-modal')).not.toBeVisible({ timeout: 3_000 });
});

// ---------------------------------------------------------------------------
// Test 4: Comments anchored on a diagram node appear in the side panel
// ---------------------------------------------------------------------------
test('comments anchored on diagram text appear in the fullscreen panel', async ({ page }) => {
  await openMermaidFixture(page);

  // Add a comment anchored on "Login" (a node label in the flowchart)
  // The mermaid SVG renders "Login" as a <text> element.
  await page
    .locator('.mermaid-block svg text', { hasText: 'Login' })
    .first()
    .waitFor({ timeout: 10_000 });

  // Select "Login" in the in-page SVG to open the comment composer
  await page.evaluate(() => {
    const textEl = [...document.querySelectorAll('.mermaid-block svg text')].find(
      (t) => (t.textContent || '').trim() === 'Login',
    ) as SVGElement | undefined;
    if (!textEl) throw new Error('SVG text "Login" not found');

    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const tn = walker.nextNode() as Text | null;
    if (!tn) throw new Error('No text node in "Login" element');

    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, tn.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const rect = range.getBoundingClientRect();
    textEl.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  });

  // Composer should open (mini bubble with a "Comment" button)
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 5_000 });
  await commentBtn.click();

  const commentText = 'Login node comment for fullscreen test';
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  // Wait until the form closes (confirming save)
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5_000 });

  // Open the fullscreen modal
  await openFullscreenModal(page);

  // The panel should show the comment anchored on "Login"
  const panel = page.locator('[aria-label="Diagram comments"]');
  await expect(panel).toBeVisible({ timeout: 5_000 });

  // The ThreadCard should display the anchor text "Login" (rendered with curly quotes)
  await expect(panel.getByText('“Login”', { exact: true })).toBeVisible({ timeout: 5_000 });
  // And the comment body text should also be visible
  await expect(panel.getByText(commentText, { exact: true })).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 5: Selecting text on a node in fullscreen opens the floating comment form
// ---------------------------------------------------------------------------
test('selecting SVG text in fullscreen opens the floating comment form', async ({ page }) => {
  await openMermaidFixture(page);
  await openFullscreenModal(page);

  // Wait for canvas SVG to render
  await expect(page.locator('.mermaid-fullscreen-canvas-inner svg')).toBeVisible({ timeout: 8_000 });
  await page
    .locator('.mermaid-fullscreen-canvas-inner svg text', { hasText: 'Dashboard' })
    .first()
    .waitFor({ timeout: 10_000 });

  // Programmatically select "Dashboard" in the fullscreen canvas SVG
  await selectSubstringInFullscreenSvg(page, 'Dashboard', 'Dashboard');

  // The floating CommentForm bubble should appear (same UX as the main app)
  const form = page.locator('[data-comment-form]');
  await expect(form).toBeVisible({ timeout: 5_000 });
  await expect(form.getByRole('button', { name: 'Comment' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 6: Removing the diagram block from the markdown auto-closes the modal
// ---------------------------------------------------------------------------
test('modal auto-closes when the underlying diagram block is removed from the markdown', async ({
  page,
}) => {
  await openMermaidFixture(page);
  await openFullscreenModal(page);
  await expect(page.locator('.mermaid-fullscreen-modal')).toBeVisible();

  // Strip the mermaid block from the fixture file. The dev server picks up
  // the change and the App pushes a fresh `cleanMarkdown` to the modal — the
  // auto-close effect fires when the active source no longer appears.
  writeFileSync(FIXTURE_PATH, '# Diagram\n\nSome prose after the diagram.\n');

  await expect(page.locator('.mermaid-fullscreen-modal')).toBeHidden({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 7: Clicking a highlighted SVG label activates the corresponding comment
// ---------------------------------------------------------------------------
test('clicking a highlighted SVG label activates the comment in the panel', async ({ page }) => {
  await openMermaidFixture(page);

  // Add a comment on "Login" via inline view first (mirrors test 4 setup)
  await page.locator('.mermaid-block svg text', { hasText: 'Login' }).first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => {
    const textEl = [...document.querySelectorAll('.mermaid-block svg text')].find(
      (t) => (t.textContent || '').trim() === 'Login',
    ) as SVGElement | undefined;
    if (!textEl) throw new Error('SVG text "Login" not found');
    const tn = (document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT).nextNode() as Text | null)!;
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, tn.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const rect = range.getBoundingClientRect();
    textEl.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  });
  await page.locator('[data-comment-form] button', { hasText: 'Comment' }).click();
  await page.getByPlaceholder('Add your comment...').fill('click-to-activate test');
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByPlaceholder('Add your comment...')).not.toBeVisible({ timeout: 5_000 });

  await openFullscreenModal(page);

  // Click the highlighted Login label inside the canvas SVG
  const labeled = page.locator('.mermaid-fullscreen-canvas-inner svg text.mermaid-comment-highlight').first();
  await expect(labeled).toBeVisible({ timeout: 5_000 });
  await labeled.click({ force: true });

  // The panel's ThreadCard for that comment should be marked active.
  // CommentCard wraps an inner div that gets `ring-1` when isActive is true.
  await expect(
    page.locator('[aria-label="Diagram comments"] [data-comment-card-id] .ring-1').first(),
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 8: Toolbar comment-panel toggle hides and shows the side panel
// ---------------------------------------------------------------------------
test('toolbar comment-panel button toggles the side panel', async ({ page }) => {
  await openMermaidFixture(page);
  await openFullscreenModal(page);
  await expect(page.locator('[aria-label="Diagram comments"]')).toBeVisible();

  await page
    .locator('.mermaid-fullscreen-toolbar button[aria-label="Toggle comment panel"]')
    .click();
  await expect(page.locator('[aria-label="Diagram comments"]')).toBeHidden();

  await page
    .locator('.mermaid-fullscreen-toolbar button[aria-label="Toggle comment panel"]')
    .click();
  await expect(page.locator('[aria-label="Diagram comments"]')).toBeVisible();
});
