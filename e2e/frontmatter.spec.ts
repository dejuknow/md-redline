import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addComment } from './helpers/comments';
import { resetTestAppState } from './helpers/test-state';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_FIXTURE_DIR = resolve(__dirname, '..', 'node_modules', '.md-redline-e2e');

// Deliberately contains the characters the HTML serializer has to escape
// (<, >, &, both quote flavours). The innerText comparison below then proves
// they survive the round trip and decode back to the source exactly, which is
// what comment anchoring depends on.
const SKILL_DOC = `---
name: mcp2cli
description: Use when an MCP server should be driven from the shell
pattern: <server> & "tool" or 'alias'
tools:
  - Read
  - Write
---

# Overview

Body text that follows the frontmatter.
`;

let fixtureDir = '';
let fixturePath = '';

test.beforeEach(async ({ page }, testInfo) => {
  mkdirSync(TEMP_FIXTURE_DIR, { recursive: true });
  fixtureDir = resolve(
    TEMP_FIXTURE_DIR,
    `frontmatter-${process.pid}-${testInfo.retry}-${Date.now()}`,
  );
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = resolve(fixtureDir, 'skill-doc.md');
  writeFileSync(fixturePath, SKILL_DOC);
  await resetTestAppState(page);
});

test.afterEach(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function openFixture(page: Page) {
  await page.goto(`/?file=${fixturePath}`);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Frontmatter in the rendered view', () => {
  test('renders the block above the first heading with its text intact', async ({ page }) => {
    await openFixture(page);

    const block = page.locator('.doc-frontmatter');
    await expect(block).toBeVisible();

    // Byte-identical to the source between the fences. Comment anchoring
    // searches the raw file for whatever the DOM hands it, so any
    // transformation here breaks commenting silently.
    const text = await block.innerText();
    const expected = SKILL_DOC.split('---\n')[1].replace(/\n$/, '');
    expect(text.replace(/\r/g, '')).toBe(expected);
  });

  test('comments on a frontmatter value without corrupting the block', async ({ page }) => {
    await openFixture(page);

    await addComment(
      page,
      'Use when an MCP server should be driven from the shell',
      'too vague, name the shapes',
    );

    await expect
      .poll(() => readFileSync(fixturePath, 'utf-8'), { timeout: 10_000 })
      .toContain('too vague, name the shapes');

    const content = readFileSync(fixturePath, 'utf-8');
    // The marker sits after the closing fence, never inside it.
    const fenceEnd = content.indexOf('\n---\n') + '\n---\n'.length;
    expect(content.slice(0, fenceEnd)).not.toContain('@comment');
    expect(content.startsWith('---\nname: mcp2cli\n')).toBe(true);
    expect(content).toContain('description: Use when an MCP server should be driven from the shell');

    // And the highlight paints on the field itself.
    const mark = page.locator('.doc-frontmatter mark');
    await expect(mark).toHaveText('Use when an MCP server should be driven from the shell');
  });

  test('leaves a document without frontmatter alone', async ({ page }) => {
    writeFileSync(fixturePath, '# Plain\n\nNo frontmatter here.\n');
    await page.goto(`/?file=${fixturePath}`);
    await expect(page.getByRole('heading', { name: 'Plain' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.doc-frontmatter')).toHaveCount(0);
  });
});
