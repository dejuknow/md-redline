import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/extreme-mermaid-stress.md');
const SECTION_COUNT = 220;
const EXTREME_ANCHOR = 'POST /api/reviews?file=~/docs/specs/extreme-v2.md&mode=diff#tail';

function buildFixture() {
  return [
    '---',
    'title: Extreme Mermaid Stress Doc',
    'owner: qa-platform',
    'tags:',
    '  - stress',
    '  - extreme',
    '  - mermaid',
    '  - markdown',
    'summary: Huge generated markdown fixture for browser stress testing.',
    '---',
    '',
    '# Extreme Mermaid Stress Doc',
    '',
    'This generated fixture intentionally combines frontmatter, long prose, nested lists, big tables, code fences, and hundreds of Mermaid diagrams to stress the rendered markdown path end to end.',
    '',
    '## Runbook',
    '',
    '1. Load the file.',
    '2. Hydrate every Mermaid diagram.',
    '3. Scroll near the tail and create a comment on a punctuation-heavy anchor.',
    '',
    ...Array.from({ length: SECTION_COUNT }, (_, index) => {
      const lane = index + 1;
      return `## Extreme Lane ${lane}

This lane exists to increase document size and rendering pressure. It repeats realistic markdown structures so the viewer has to deal with a large mixture of paragraphs, links, code, tables, and Mermaid diagrams without losing comment fidelity. Lane ${lane} references [lane ${lane} dashboard](https://example.com/extreme/${lane}) and the cached file \`~/docs/extreme/lane-${lane}.md\`.

### Signals ${lane}

1. Preserve heading structure for lane ${lane}.
2. Preserve the ability to select text around punctuation-heavy paths like \`~/docs/extreme/lane-${lane}.md\`.
3. Keep the sidebar and viewer responsive after repeated saves.

- Reviewer pool:
  - agent-${lane % 9}
  - reviewer-${lane % 5}
- Queue markers:
  - lane-${lane}-draft
  - lane-${lane}-ready

> Extreme lane ${lane} note: the comment system should still match anchors after lots of repeated markdown patterns and scrolling.

| Metric | Value | Notes |
| --- | --- | --- |
| Lane | ${lane} | Repeated to enlarge table parsing load |
| Path | \`~/docs/extreme/lane-${lane}.md\` | File-like anchor text |
| Status | ${lane % 3 === 0 ? 'blocked' : lane % 2 === 0 ? 'approved' : 'queued'} | Rotates through realistic states |
| Window | ${8 + (lane % 6)}h | Long document with varied cells |

\`\`\`mermaid
flowchart TD
  A${lane}[Lane ${lane} intake] -->|approve ${lane}| B${lane}[Lane ${lane} review]
  B${lane} --> C${lane}{Risk ${lane} accepted?}
  C${lane} -->|yes| D${lane}[Lane ${lane} ship]
  C${lane} -->|no| E${lane}[Lane ${lane} revise]
  E${lane} --> F${lane}[Lane ${lane} resubmit]
\`\`\`

\`\`\`json
{
  "lane": ${lane},
  "path": "~/docs/extreme/lane-${lane}.md",
  "status": "${lane % 3 === 0 ? 'blocked' : lane % 2 === 0 ? 'approved' : 'queued'}",
  "retryBudget": ${lane % 4}
}
\`\`\`
`;
    }),
    '## Tail Appendix',
    '',
    'The appendix sits after hundreds of sections so we can prove that selection and commenting still work near the bottom of a very large markdown document.',
    '',
    `Use ${EXTREME_ANCHOR} when you need to reopen the tail-focused diff workflow for the extreme stress scenario.`,
    '',
    '| Tail Check | Value |',
    '| --- | --- |',
    '| Path | `~/docs/specs/extreme-v2.md` |',
    '| Mode | `diff` |',
    '| Focus | `tail` |',
    '',
    'Closing note: if this paragraph is easy to select and comment on, the document stayed interactive all the way through the extreme fixture.',
    '',
  ].join('\n');
}

const FIXTURE_CONTENT = buildFixture();

test.describe.configure({ timeout: 120_000 });

test.beforeAll(() => {
  writeFileSync(FIXTURE, FIXTURE_CONTENT);
});

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_CONTENT);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test.afterAll(() => {
  if (existsSync(FIXTURE)) rmSync(FIXTURE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Extreme Mermaid Stress Doc' })).toBeVisible({
    timeout: 15_000,
  });
}

async function selectText(page: Page, text: string) {
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
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        const rect = range.getBoundingClientRect();
        node.parentElement?.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
        return;
      }
    }
    throw new Error(`Text "${targetText}" not found in rendered markdown`);
  }, text);
}

async function addComment(page: Page, anchorText: string, commentText: string) {
  await selectText(page, anchorText);
  const commentBtn = page.locator('[data-comment-form] button', { hasText: 'Comment' });
  await expect(commentBtn).toBeVisible({ timeout: 10_000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

test('renders and comments through an extreme markdown document', async ({ page }) => {
  test.slow();
  await openFixture(page);

  await expect(page.locator('.mermaid-block .mermaid-svg svg')).toHaveCount(SECTION_COUNT, {
    timeout: 90_000,
  });
  await expect(page.locator('.mermaid-error')).toHaveCount(0);

  await page.getByRole('heading', { name: 'Tail Appendix' }).scrollIntoViewIfNeeded();
  await page.locator('.prose').getByText(EXTREME_ANCHOR).scrollIntoViewIfNeeded();
  await addComment(
    page,
    EXTREME_ANCHOR,
    'Tail anchor still works even after hundreds of Mermaid sections and mixed markdown blocks.',
  );

  await page.waitForTimeout(750);
  const saved = readFileSync(FIXTURE, 'utf-8');
  expect(saved).toContain('@comment');
  expect(saved).toContain(EXTREME_ANCHOR);
  expect(saved.match(/^```mermaid$/gm)).toHaveLength(SECTION_COUNT);
});
