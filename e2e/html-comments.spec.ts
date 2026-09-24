import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');

// The block comment's body carries the characters the HTML serializer has to
// escape (<, >, &, both quote flavours). insertComment anchors by searching the
// raw file for whatever the DOM handed it, so the innerText comparison below is
// what proves commenting on a rendered comment can work at all.
const BODY = 'TODO: decide the <retry> loop & its "budget"';
const DOC = `# Notes

<!-- ${BODY} -->

Body text after the comment.

A paragraph with an <!-- inline note --> in the middle of it.
`;

let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `html-comments-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'notes.md');
  writeFileSync(fixturePath, DOC);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

/** Flip the "Render HTML comments" switch in the Settings panel. */
async function toggleRenderHtmlComments(page: Page) {
  await page.locator('button[title*="Settings"]').click();
  const panel = page.locator('.fixed.inset-0');
  await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
  await panel
    .locator('label', { hasText: 'Render HTML comments' })
    .locator('button[role="switch"]')
    .click();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });
}

test.describe('HTML comments in the rendered view', () => {
  test('renders the body verbatim, with the delimiters as unselectable chrome', async ({
    page,
  }) => {
    await openFixture(page);

    const block = page.locator('.doc-html-comment.doc-html-comment--block');
    await expect(block).toBeVisible();

    // Byte-identical to the source between the delimiters, INCLUDING the
    // padding spaces that `<!-- x -->` puts either side of the value. Any
    // transformation here — trimming included — means insertComment cannot find
    // the anchor and the comment vanishes with no marker and no error.
    expect((await block.innerText()).replace(/\r/g, '')).toBe(` ${BODY} `);

    // The delimiters are ::before/::after, so they are not in the text layer.
    expect(await block.innerText()).not.toContain('<!--');
    expect(await block.innerText()).not.toContain('-->');

    // A comment inside a paragraph stays inline rather than owning a line.
    const inline = page.locator('.doc-html-comment:not(.doc-html-comment--block)');
    await expect(inline).toHaveText('inline note');
  });

  test('comments on a comment body without nesting the marker inside it', async ({ page }) => {
    await openFixture(page);

    await addComment(page, 'decide the <retry> loop', 'which budget?');

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('which budget?');

    const content = readFileSync(fixturePath, 'utf-8');

    // The marker sits on its own line BEFORE the block. Nested, the first
    // `-->` would close the outer comment and spill the rest as visible text.
    expect(content).not.toMatch(/<!-- TODO: <!--/);
    const lines = content.split('\n');
    const markerIndex = lines.findIndex((l) => l.includes('@comment'));
    const blockIndex = lines.findIndex((l) => l === `<!-- ${BODY} -->`);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(blockIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeLessThan(blockIndex);
    // The marker owns its own line rather than sharing one with the comment
    // it annotates.
    expect(lines[markerIndex].startsWith('<!-- @comment')).toBe(true);
    expect(lines[markerIndex].endsWith('-->')).toBe(true);

    // The anchor survived the escaping round trip intact. It lives in the
    // marker's JSON, where `>` is escaped as \u003e to keep `-->` from closing
    // the marker early, so read it back through the parser rather than by
    // string match on the line.
    const marker = JSON.parse(lines[markerIndex].slice('<!-- @comment'.length, -' -->'.length)) as {
      anchor: string;
    };
    expect(marker.anchor).toBe('decide the <retry> loop');

    // And the highlight paints on the body, not on the delimiters.
    const mark = page.locator('.doc-html-comment mark');
    await expect(mark).toHaveText('decide the <retry> loop');
  });

  test('reloads the commented document and comments on the same body again', async ({ page }) => {
    await openFixture(page);
    await addComment(page, 'decide the <retry> loop', 'first pass');
    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('first pass');

    await openFixture(page);
    await addComment(page, 'its "budget"', 'second pass');
    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('second pass');

    const content = readFileSync(fixturePath, 'utf-8');
    // Two markers, both outside the block, and the block itself unchanged.
    expect(content.match(/@comment/g)).toHaveLength(2);
    expect(content).toContain(`<!-- ${BODY} -->`);
    expect(content).not.toMatch(/<!-- TODO: <!--/);
    expect(content).not.toMatch(/@comment[^>]*@comment/);
  });

  test('the Settings toggle turns rendering off and back on', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('.doc-html-comment').first()).toBeVisible();

    await toggleRenderHtmlComments(page);
    await expect(page.locator('.doc-html-comment')).toHaveCount(0);

    await toggleRenderHtmlComments(page);
    await expect(page.locator('.doc-html-comment').first()).toBeVisible();
  });

  test('hides a directive comment by its shipped prefix, and renders it once its tool is unticked', async ({
    page,
  }) => {
    writeFileSync(
      fixturePath,
      '# Notes\n\n<!-- prettier-ignore -->\n\n<!-- a genuine note -->\n\nBody.\n',
    );
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });

    // Only the reader-addressed one renders; the formatter directive does not.
    await expect(page.locator('.doc-html-comment')).toHaveCount(1);
    await expect(page.locator('.doc-html-comment')).toHaveText('a genuine note');

    // Unticking the tool in Settings brings the directive back, which is what
    // makes a false positive on a short prefix (`more`, `toc`) fixable.
    await page.locator('button[title*="Settings"]').click();
    const panel = page.locator('.fixed.inset-0');
    await expect(panel.getByText('Settings').first()).toBeVisible({ timeout: 5000 });
    await panel.getByRole('button', { name: /keep hidden: instructions for tools/i }).click();
    await panel.getByRole('checkbox', { name: 'Keep Prettier comments hidden' }).click();
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();

    await expect(page.locator('.doc-html-comment')).toHaveCount(2);
  });

  test('keeps a multi-line comment on its own lines', async ({ page }) => {
    // innerText reads the rendered text layer, where CSS decides whether the
    // newlines in the DOM are shown, and which a selection anchor is taken from.
    writeFileSync(fixturePath, '# Notes\n\n<!-- $ echo hi\nhi\n-->\n\nBody.\n');
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });

    const pre = page.locator('.doc-html-comment.doc-html-comment--pre');
    await expect(pre).toBeVisible();
    const text = (await pre.innerText()).replace(/\r/g, '');
    expect(text).toContain('$ echo hi\nhi');
    // The delimiters are ::before/::after, so they are not in the text layer.
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('-->');
  });

  test('anchors a comment on the first line of a multi-line body, whose leading space was trimmed', async ({
    page,
  }) => {
    // The rendered first line drops the separator space after `<!--`, so this
    // is the line where the trim could break anchoring.
    writeFileSync(
      fixturePath,
      '# Notes\n\n<!-- open question\nwhich retry budget?\n-->\n\nBody.\n',
    );
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });

    const pre = page.locator('.doc-html-comment.doc-html-comment--pre');
    await expect(pre).toHaveText(/^open question/);

    await addComment(page, 'open question', 'which check?');

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('which check?');

    const content = readFileSync(fixturePath, 'utf-8');
    const lines = content.split('\n');
    const markerIndex = lines.findIndex((l) => l.includes('@comment'));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const marker = JSON.parse(lines[markerIndex].slice('<!-- @comment'.length, -' -->'.length)) as {
      anchor: string;
    };
    expect(marker.anchor).toBe('open question');
    // The block itself is untouched, and the marker did not nest inside it.
    expect(content).toContain('<!-- open question\nwhich retry budget?\n-->');
    expect(content).not.toMatch(/<!-- open question[^\n]*<!--/);
  });

  test('does not render a leftover @comment marker as a note', async ({ page }) => {
    // A well-formed marker never reaches the renderer; a malformed one that
    // survived stripping must stay hidden rather than render the parser's guts.
    writeFileSync(fixturePath, '# Notes\n\n<!-- @comment{"id":"x","anchor" -->\n\nBody.\n');
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.doc-html-comment')).toHaveCount(0);
  });
});

// The forms fixture is also a hand-testing document: each section says what to
// expect. This checks the sections a selector can judge.
const FORMS_FIXTURE = resolve(__dirname, 'fixtures/html-comment-forms.md');

test.describe('HTML comment forms fixture', () => {
  test('renders, hides and preformats each form as its section says', async ({ page }) => {
    await page.goto(`/?file=${FORMS_FIXTURE}`);
    await expect(page.getByRole('heading', { name: 'HTML comment forms' })).toBeVisible({
      timeout: 10_000,
    });

    const comments = page.locator('.doc-html-comment');
    const bodies = (await comments.allInnerTexts()).map((t) => t.replace(/\r/g, ''));
    const shown = (fragment: string) => bodies.some((b) => b.includes(fragment));

    // Section 7: every shipped directive is hidden.
    for (const directive of [
      'prettier-ignore -',
      'lint disable',
      'markdownlint-disable',
      'deno-fmt-ignore',
      'textlint-disable',
      'alex ignore',
      'vale off',
      'vale Microsoft',
      'cSpell:ignore',
      'cspell:words',
      'doctoc generated',
      "DON'T EDIT",
      'TOC',
      'markdown-link-check',
      'truncate',
      'ALL-CONTRIBUTORS',
      'omit from toc',
    ]) {
      expect(shown(directive), directive).toBe(false);
    }

    // Section 8: a note that only mentions a directive still renders.
    expect(shown('We use prettier-ignore on the table')).toBe(true);

    // Section 9: a short prefix hides its directive and a note opening with the
    // same word, but not a longer word that starts with the same letters.
    expect(shown('more thought needed')).toBe(false);
    expect(shown('moreover, this paragraph')).toBe(true);
    expect(shown('tocopherol')).toBe(true);
    // ...and matching is case-sensitive, so a capitalised note still renders.
    expect(shown('More thought needed')).toBe(true);

    // Section 12: an empty comment is never rendered as an empty note.
    expect(bodies.some((b) => b.trim() === '')).toBe(false);

    // Section 10: a malformed marker never renders.
    expect(shown('comment-malformed')).toBe(false);

    // Section 5: a multi-line body keeps its line breaks and column alignment.
    const pre = page.locator('.doc-html-comment--pre');
    await expect(pre).toHaveCount(2);
    expect((await pre.nth(0).innerText()).replace(/\r/g, '')).toBe(
      'A comment spanning several lines.\nThe second line.\n    An indented third line, to check that leading whitespace is emitted verbatim.',
    );
    expect(await pre.nth(1).innerText()).toContain('\n     ▲                    │\n');
  });
});
