import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './pipeline';

describe('renderMarkdown', () => {
  it('renders basic markdown (headings, paragraphs, bold, italic)', () => {
    const md = '# Hello\n\nThis is **bold** and *italic*.';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders GFM tables correctly', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders strikethrough correctly', () => {
    const md = '~~deleted~~';
    const html = renderMarkdown(md);
    expect(html).toContain('<del>deleted</del>');
  });

  it('allows <mark> elements with className', () => {
    const md = '<mark class="highlight">important</mark>';
    const html = renderMarkdown(md);
    expect(html).toContain('<mark');
    expect(html).toContain('important</mark>');
    expect(html).toContain('class="highlight"');
  });

  it('strips <script> tags', () => {
    const md = 'Hello <script>alert("xss")</script> world';
    const html = renderMarkdown(md);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert');
  });

  it('strips <style> tags', () => {
    const md = 'Hello <style>body{display:none}</style> world';
    const html = renderMarkdown(md);
    expect(html).not.toContain('<style>');
    // rehype-sanitize removes the tag but may leave text content; the key
    // guarantee is the <style> element itself is gone so no CSS executes.
  });

  it('strips onclick and other event handler attributes', () => {
    const md = '<div onclick="alert(1)">click me</div>';
    const html = renderMarkdown(md);
    expect(html).not.toContain('onclick');
    expect(html).toContain('click me');
  });

  it('preserves className attribute on elements', () => {
    const md = '<span class="custom">text</span>';
    const html = renderMarkdown(md);
    expect(html).toContain('class="custom"');
  });

  it('handles YAML frontmatter (should not appear in output)', () => {
    const md = '---\ntitle: Test\nauthor: Someone\n---\n\n# Content';
    const html = renderMarkdown(md);
    expect(html).not.toContain('title: Test');
    expect(html).not.toContain('author: Someone');
    expect(html).toContain('<h1>Content</h1>');
  });

  it('handles empty input', () => {
    const html = renderMarkdown('');
    expect(html).toBe('');
  });

  it('handles fenced code blocks', () => {
    const md = '```js\nconsole.log("hi");\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('<code');
    expect(html).toContain('console.log');
  });

  it('rewrites a relative image src when filePath is provided', () => {
    const md = '![diagram](./diagram.png)';
    const html = renderMarkdown(md, '/abs/dir/file.md');
    expect(html).toContain(
      `src="/api/asset?path=${encodeURIComponent('/abs/dir/diagram.png')}"`,
    );
  });

  it('rewrites a relative .md link to a data attribute when filePath is provided', () => {
    const md = '[other](./other.md)';
    const html = renderMarkdown(md, '/abs/dir/file.md');
    expect(html).toContain('data-mdr-local-md="/abs/dir/other.md"');
    expect(html).toContain('href="#"');
  });

  it('preserves data-mdr-fragment through the sanitizer', () => {
    const md = '[other](./other.md#intro)';
    const html = renderMarkdown(md, '/abs/dir/file.md');
    expect(html).toContain('data-mdr-fragment="intro"');
  });

  it('leaves relative paths unchanged when filePath is omitted (regression)', () => {
    const md = '![x](./img.png)\n\n[y](./other.md)';
    const html = renderMarkdown(md);
    expect(html).toContain('src="./img.png"');
    expect(html).toContain('href="./other.md"');
    expect(html).not.toContain('data-mdr-local-md');
  });

  it('still rewrites absolute paths when filePath is omitted', () => {
    const md = '![x](/abs/img.png)';
    const html = renderMarkdown(md);
    expect(html).toContain(
      `src="/api/asset?path=${encodeURIComponent('/abs/img.png')}"`,
    );
  });

  it('opens external links in a new tab through the full pipeline', () => {
    const md = '[ext](https://example.com)';
    const html = renderMarkdown(md);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
