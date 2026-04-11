import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

/**
 * Regression coverage for mermaid label comment highlights, covering both
 * diagram families that render labels as plain SVG <text>:
 *
 *  - sequenceDiagram — labels are flat <text> with a single text-node child
 *  - flowchart — labels are <text> with nested <tspan> rows + inner tspans
 *
 * Flowchart labels render as SVG text (not foreignObject) because mermaid is
 * initialized with htmlLabels: false. foreignObject is stripped by DOMPurify
 * for security (it can embed arbitrary HTML). The "text disappears when you
 * select it" regression manifested differently but had the same root cause:
 * wrapText was injecting an HTML <mark> inside an SVG <text>, which SVG
 * cannot render. The fix redirects those wraps to style the parent <text>
 * and draw a sibling highlight <rect>.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Diagram {
  name: string;
  fixturePath: string;
  markdown: string;
  /** Text used to find the target SVG <text> element (via `hasText`). Can be
   *  a substring of the full label. */
  labelText: string;
  /** Substring to select and comment on. */
  substring: string;
}

const DIAGRAMS: Diagram[] = [
  {
    name: 'sequence',
    fixturePath: resolve(__dirname, 'fixtures/mermaid-sequence-highlight.md'),
    markdown: `# Sequence Highlight Regression

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: POST /auth/login
    S-->>C: JWT
\`\`\`
`,
    labelText: 'POST /auth/login',
    substring: 'auth',
  },
  {
    name: 'flowchart',
    fixturePath: resolve(__dirname, 'fixtures/mermaid-flowchart-highlight.md'),
    markdown: `# Flowchart Highlight Regression

\`\`\`mermaid
flowchart TD
    A[Admin navigates to Knowledge Vaults] --> B[Clicks Create]
    B --> C[Selects source type]
\`\`\`
`,
    // textContent of the wrapped label is "Admin navigates toKnowledge Vaults"
    // (tspan rows concatenate without whitespace). Use a substring that only
    // matches one element.
    labelText: 'Admin navigates',
    substring: 'Admin',
  },
];

test.beforeEach(async ({ page }) => {
  for (const diag of DIAGRAMS) writeFileSync(diag.fixturePath, diag.markdown);
  await resetTestAppState(page);
});

test.afterAll(() => {
  for (const diag of DIAGRAMS) writeFileSync(diag.fixturePath, diag.markdown);
});

async function openFixture(page: Page, diag: Diagram) {
  await page.goto(`/?file=${diag.fixturePath}`);
  await page.locator('.prose').waitFor({ timeout: 10_000 });
  await page.locator('.mermaid-block .mermaid-svg svg').first().waitFor({ timeout: 10_000 });
  // Wait for the label we'll operate on to be in the DOM
  await page
    .locator('.mermaid-block svg text', { hasText: diag.labelText })
    .first()
    .waitFor({ timeout: 10_000 });
}

/** Programmatically select a substring inside an SVG <text> element and
 *  dispatch mouseup so useSelection opens the comment composer. Walks text
 *  nodes via TreeWalker so it handles both flat and nested (tspan) structures. */
async function selectSubstringInSvgText(page: Page, labelText: string, substring: string) {
  await page.evaluate(
    ([full, needle]) => {
      const textEl = [...document.querySelectorAll('.mermaid-block svg text')].find((t) =>
        (t.textContent || '').includes(full),
      ) as SVGElement | undefined;
      if (!textEl) throw new Error(`SVG text containing "${full}" not found`);

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
    },
    [labelText, substring] as const,
  );
}

async function svgTextContentLength(page: Page, labelText: string): Promise<number> {
  return page
    .locator('.mermaid-block svg text', { hasText: labelText })
    .first()
    .evaluate((el) => (el.textContent || '').length);
}

for (const diag of DIAGRAMS) {
  test.describe(`mermaid ${diag.name} diagram label highlights`, () => {
    test(`selecting "${diag.substring}" keeps the full label text intact`, async ({ page }) => {
      await openFixture(page, diag);

      const beforeLen = await svgTextContentLength(page, diag.labelText);
      expect(beforeLen).toBeGreaterThan(0);

      await selectSubstringInSvgText(page, diag.labelText, diag.substring);

      // Composer should open because the selection fired mouseup
      await expect(page.locator('[data-comment-form]')).toBeVisible();

      const afterLen = await svgTextContentLength(page, diag.labelText);
      // Text content length must not shrink. Previously, wrapping the
      // matched substring in an HTML <mark> inside an SVG <text> made the
      // substring render at zero width — the DOM text was still present but
      // visually gone. We check textContent (DOM-level) to catch the case
      // where wrapText mutated the tree at all.
      expect(afterLen).toBe(beforeLen);

      // No HTML <mark> was injected anywhere inside the SVG <text>
      const marksInSvgText = await page
        .locator('.mermaid-block svg text mark, .mermaid-block svg tspan mark')
        .count();
      expect(marksInSvgText).toBe(0);
    });

    test(`saving a comment on "${diag.substring}" applies highlight class + rect and click activates`, async ({
      page,
    }) => {
      await openFixture(page, diag);
      await selectSubstringInSvgText(page, diag.labelText, diag.substring);
      await expect(page.locator('[data-comment-form]')).toBeVisible();

      // Go from the initial selection bubble to the full composer form
      await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
      const commentText = `${diag.name} label comment`;
      await page.getByPlaceholder('Add your comment...').fill(commentText);
      await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();

      await expect(page.getByText(commentText, { exact: true })).toBeVisible();

      const svgText = page
        .locator('.mermaid-block svg text', { hasText: diag.labelText })
        .first();
      await expect(svgText).toHaveClass(/mermaid-comment-highlight/);
      expect(await svgText.locator('mark').count()).toBe(0);

      // A sibling highlight <rect> is inserted to give the substring a
      // visible background
      const highlightRect = page.locator('.mermaid-block rect.mermaid-svg-text-highlight-bg');
      await expect(highlightRect.first()).toBeAttached();

      // Click the comment card → active class + stroke on the rect
      await page.getByText(commentText, { exact: true }).click();
      await expect(svgText).toHaveClass(/mermaid-comment-highlight-active/);
      const activeRect = page.locator(
        '.mermaid-block rect.mermaid-svg-text-highlight-bg[stroke]',
      );
      await expect(activeRect).toBeAttached();
    });

    test(`drag handles do not render for active comments on ${diag.name} SVG text`, async ({
      page,
    }) => {
      await openFixture(page, diag);
      await selectSubstringInSvgText(page, diag.labelText, diag.substring);
      await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
      const commentText = `${diag.name} drag handle test`;
      await page.getByPlaceholder('Add your comment...').fill(commentText);
      await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
      await expect(page.getByText(commentText, { exact: true })).toBeVisible();

      // Activate the comment
      await page.getByText(commentText, { exact: true }).click();
      await expect(
        page.locator('.mermaid-block text.mermaid-comment-highlight-active'),
      ).toBeAttached();

      // useDragHandles filters out SVG <text> active marks (the drag re-wrap
      // path would inject an HTML <mark> and corrupt the label, same root
      // cause as the original bug). Prose/HTML marks still get handles.
      expect(await page.locator('[data-drag-handle]').count()).toBe(0);
    });
  });
}
