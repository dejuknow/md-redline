// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown/pipeline';
import { sanitizeRenderedMarkdown } from './sanitize-html';

/**
 * Full production render path: markdown → rehype pipeline → DOMPurify.
 * pipeline.test.ts covers the pipeline output alone; these tests exist
 * because DOMPurify can silently strip attributes the pipeline emitted.
 */
function renderAndSanitize(markdown: string, filePath?: string): string {
  return sanitizeRenderedMarkdown(renderMarkdown(markdown, filePath));
}

describe('sanitizeRenderedMarkdown on pipeline output', () => {
  it('keeps target="_blank" on external links', () => {
    const html = renderAndSanitize('[docs](https://example.com/docs)');
    expect(html).toContain('target="_blank"');
  });

  it('keeps rel="noopener noreferrer" on external links', () => {
    const html = renderAndSanitize('[docs](https://example.com/docs)');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps target="_blank" on bare autolinks', () => {
    const html = renderAndSanitize('see https://example.com');
    expect(html).toContain('target="_blank"');
  });

  it('keeps local-md data attributes on local links', () => {
    const html = renderAndSanitize('[spec](./other.md#intro)', '/docs/readme.md');
    expect(html).toContain('data-mdr-local-md="/docs/other.md"');
    expect(html).toContain('data-mdr-fragment="intro"');
  });

  it('keeps data-comment-ids on mark elements', () => {
    const html = sanitizeRenderedMarkdown('<mark data-comment-ids="c1,c2">hi</mark>');
    expect(html).toContain('data-comment-ids="c1,c2"');
  });

  it('still strips script tags and event handlers', () => {
    const html = sanitizeRenderedMarkdown(
      '<a href="https://example.com" target="_blank" onclick="alert(1)">x</a><script>alert(2)</script>',
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<script');
  });
});
