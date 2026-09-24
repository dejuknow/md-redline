import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

  test('does not render a leftover @comment marker as a note', async ({ page }) => {
    // A well-formed marker never reaches the renderer; a malformed one that
    // survived stripping must stay hidden rather than render the parser's guts.
    writeFileSync(fixturePath, '# Notes\n\n<!-- @comment{"id":"x","anchor" -->\n\nBody.\n');
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.doc-html-comment')).toHaveCount(0);
  });
});
