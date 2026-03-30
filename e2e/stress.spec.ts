import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/large-mermaid-stress.md');
const SECTION_COUNT = 60;
const WEIRD_ANCHOR = 'GET /api/files?dir=~/docs&mode=full';

function buildFixture() {
  return [
    '---',
    'title: Large Mermaid Stress Doc',
    'owner: qa',
    'tags:',
    '  - stress',
    '  - mermaid',
    '  - markdown',
    '---',
    '',
    '# Large Mermaid Stress Doc',
    '',
    'This generated fixture stresses large markdown rendering, Mermaid replacement, and odd anchor text.',
    '',
    ...Array.from({ length: SECTION_COUNT }, (_, index) => {
      const lane = index + 1;
      return `## Review Lane ${lane}

This lane verifies that long markdown files still render consistently after repeated diagram hydration, table parsing, inline formatting, and deep scrolling. The workflow for lane ${lane} should stay readable even when the document grows large and repetitive for regression coverage.

The review packet for lane ${lane} includes multiple markdown constructs that should remain stable: linked references to [lane ${lane} docs](https://example.com/review/${lane}), inline code like \`lane-${lane}-token\`, and repeated mentions of the cache path \`~/docs/review/lane-${lane}.md\`.

> Lane ${lane} reminder: preserve author notes, preserve diagram layout, and preserve anchor selection fidelity near the end of the document.

\`\`\`mermaid
flowchart TD
  A${lane}[Lane ${lane} drafted] --> B${lane}[Lane ${lane} reviewed]
  B${lane} --> C${lane}[Lane ${lane} approved]
  C${lane} --> D${lane}[Lane ${lane} archived]
\`\`\`

Checklist ${lane}: keep headings, tables, and callouts aligned before handoff.

- Validate the selection layer around punctuation-heavy paths such as \`~/docs/review/lane-${lane}.md\`
- Verify the sidebar can still focus comments that belong to lane ${lane}
- Confirm the rendered view keeps Mermaid SVG replacement stable after saves

| Check | Value | Notes |
| --- | --- | --- |
| Lane | ${lane} | Repeated to increase table parsing pressure |
| Reviewer | agent-${lane % 7} | Round-robin reviewer placeholder |
| File | \`~/docs/review/lane-${lane}.md\` | Markdown with punctuation-heavy anchor text |

\`\`\`ts
export function lane${lane}Status(input: { approved: boolean; retries: number }) {
  if (input.approved) return 'approved';
  return input.retries > 2 ? 'needs-human-review' : 'retry';
}
\`\`\`
`;
    }),
    '## Late Appendix',
    '',
    `Use ${WEIRD_ANCHOR} to reopen the cached review state for the large document scenario.`,
    '',
    'The appendix intentionally appears after dozens of sections so we can verify selections near the bottom of a very large markdown document.',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| Path | `~/docs/specs/api-v2.md` |',
    '| Mode | `full` |',
    '',
    'Closing note: the tail of the file should be just as commentable as the first paragraph.',
    '',
  ].join('\n');
}

const FIXTURE_CONTENT = buildFixture();

test.beforeAll(() => {
  writeFileSync(FIXTURE, FIXTURE_CONTENT);
});

test.beforeEach(async ({ page }) => {
  writeFileSync(FIXTURE, FIXTURE_CONTENT);
  await resetTestAppState(page);
});

test.afterAll(() => {
  if (existsSync(FIXTURE)) rmSync(FIXTURE);
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${FIXTURE}`);
  await expect(page.getByRole('heading', { name: 'Large Mermaid Stress Doc' })).toBeVisible({
    timeout: 10_000,
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
  await expect(commentBtn).toBeVisible({ timeout: 5000 });
  await commentBtn.click();
  await page.getByPlaceholder('Add your comment...').fill(commentText);
  await page.locator('[data-comment-form]').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText(commentText, { exact: true })).toBeVisible();
}

test.describe('Large markdown and Mermaid coverage', () => {
  test('renders all Mermaid blocks in a large generated document', async ({ page }) => {
    test.slow();
    await openFixture(page);

    await expect(page.locator('.mermaid-block .mermaid-svg svg')).toHaveCount(SECTION_COUNT, {
      timeout: 20_000,
    });
    await expect(page.locator('.mermaid-error')).toHaveCount(0);

    await page.getByRole('heading', { name: 'Late Appendix' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: 'Late Appendix' })).toBeVisible();
  });

  test('comments on a punctuation-heavy anchor near the end of a Mermaid-heavy file', async ({
    page,
  }) => {
    test.slow();
    await openFixture(page);
    await expect(page.locator('.mermaid-block .mermaid-svg svg')).toHaveCount(SECTION_COUNT, {
      timeout: 20_000,
    });

    await page.locator('.prose').getByText(WEIRD_ANCHOR).scrollIntoViewIfNeeded();
    await addComment(
      page,
      WEIRD_ANCHOR,
      'Document how this endpoint behaves when the reviewed file lives outside the repo.',
    );

    await page.waitForTimeout(500);
    const saved = readFileSync(FIXTURE, 'utf-8');
    expect(saved).toContain('@comment');
    expect(saved).toContain(WEIRD_ANCHOR);
    expect(saved.match(/^```mermaid$/gm)).toHaveLength(SECTION_COUNT);
  });
});
