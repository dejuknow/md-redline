import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './pipeline';

describe('renderMarkdown source positions', () => {
  const attrs = (html: string, tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>`).exec(html);
    return m ? m[0] : '';
  };

  it('annotates a block with the source span it came from', () => {
    const md = 'The migration runs in **three phases** now.';
    const html = renderMarkdown(md);
    const p = attrs(html, 'p');
    const span = /data-src-start="(\d+)" data-src-end="(\d+)"/.exec(p);
    expect(span).not.toBeNull();
    // The span is the markdown, delimiters included, not the rendered text.
    expect(md.slice(Number(span![1]), Number(span![2]))).toBe(md);
  });

  it('leaves table cells unannotated, since their spans include the pipes', () => {
    // remark-gfm starts a cell's position at the preceding pipe, so adjacent
    // cells share a delimiter and neither slices back to its own content.
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(attrs(html, 'th')).not.toContain('data-src-start');
    expect(attrs(html, 'td')).not.toContain('data-src-start');
    expect(attrs(html, 'table')).toContain('data-src-start');
  });

  it('leaves blocks inside a blockquote unannotated, since the markers travel with them', () => {
    // A paragraph inside a blockquote spans "quoted line\n> more": slicing it
    // hands back a stray marker in the middle of the text. The blockquote's own
    // span is clean, so that is the one worth keeping.
    const html = renderMarkdown('> quoted line\n> more quoted');
    expect(attrs(html, 'blockquote')).toContain('data-src-start');
    expect(attrs(html, 'p')).not.toContain('data-src-start');
  });

  it('leaves inline elements unannotated, which is what keeps the HTML small', () => {
    const html = renderMarkdown('Some **bold** and a [link](https://example.com).');
    expect(attrs(html, 'strong')).not.toContain('data-src-start');
    expect(attrs(html, 'a')).not.toContain('data-src-start');
    expect(attrs(html, 'p')).toContain('data-src-start');
  });

  it('annotates block elements so a whole paragraph can be sliced back', () => {
    const md = '# Title\n\nFirst paragraph.\n\nSecond paragraph.';
    const html = renderMarkdown(md);
    const second = /<p[^>]*data-src-start="(\d+)" data-src-end="(\d+)"[^>]*>Second/.exec(html);
    expect(second).not.toBeNull();
    expect(md.slice(Number(second![1]), Number(second![2]))).toBe('Second paragraph.');
  });

  it('does not let a document forge its own positions', () => {
    // The annotator runs after sanitize, so authored data-src-* is stripped
    // first and then overwritten with the real span.
    const md = 'Text with <span data-src-start="0" data-src-end="99999">raw html</span> in it.';
    const html = renderMarkdown(md);
    expect(html).not.toContain('data-src-end="99999"');
  });

  it('counts a leading byte-order mark, so spans index the string it was handed', () => {
    // micromark skips a BOM before it starts counting. Without correcting for
    // it every span is one short: a copy sliced by it drops the block's last
    // character and picks up the delimiter before its first.
    const source = '\uFEFFFirst para.\n\nSecond para.\n';
    const html = renderMarkdown(source);
    const spans = [...html.matchAll(/data-src-start="(\d+)" data-src-end="(\d+)"/g)];
    expect(spans.map((m) => source.slice(Number(m[1]), Number(m[2])))).toEqual([
      'First para.',
      'Second para.',
    ]);
  });
});

describe('renderMarkdown', () => {
  it('renders basic markdown (headings, paragraphs, bold, italic)', () => {
    const md = '# Hello\n\nThis is **bold** and *italic*.';
    const html = renderMarkdown(md);
    expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders GFM tables correctly', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toMatch(/<th[^>]*>A<\/th>/);
    expect(html).toMatch(/<td[^>]*>1<\/td>/);
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

  it('renders YAML frontmatter as document content', () => {
    const md = '---\ntitle: Test\nauthor: Someone\n---\n\n# Content';
    const html = renderMarkdown(md);
    expect(html).toContain('class="doc-frontmatter"');
    expect(html).toContain('title');
    expect(html).toContain('Someone');
    expect(html).toMatch(/<h1[^>]*>Content<\/h1>/);
  });

  it('renders TOML frontmatter too', () => {
    const html = renderMarkdown('+++\ntitle = "Post"\n+++\n\n# Content');
    expect(html).toContain('class="doc-frontmatter"');
    expect(html).toContain('"Post"');
  });

  it('emits frontmatter text byte-identically, fences excluded', () => {
    // Comment anchoring searches the raw markdown for text the DOM handed it,
    // so any transformation here silently breaks comment creation. Compare the
    // element's text content against the source block verbatim.
    const body =
      'name: mcp2cli\ndescription: Use when a server should be driven\n  from the shell.\ntools:\n  - Read';
    const html = renderMarkdown(`---\n${body}\n---\n\n# Overview`);
    const inner = html.slice(
      html.indexOf('<div class="doc-frontmatter">') + '<div class="doc-frontmatter">'.length,
      html.indexOf('</div>'),
    );
    const text = inner.replace(/<[^>]+>/g, '');
    expect(text).toBe(body);
  });

  it('does not style continuation lines as keys', () => {
    // A folded value's continuation lines routinely contain a colon (a URL, a
    // ratio, a time). Matching key shape alone painted `http` and `3` as keys,
    // while a genuinely nested key under a valueless parent must still style.
    const md =
      '---\ndescription: See docs at\n  http://example.com:8080/path\nnote: Ratio is\n  3:4 approx\ntools:\n  - Read\nnested:\n  key: value\n---\n\n# H';
    const keys = [...renderMarkdown(md).matchAll(/doc-frontmatter__key">([^<]*)</g)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(['description', 'note', 'tools', 'nested', 'key']);
  });

  it('does not treat a mid-document --- as frontmatter', () => {
    const html = renderMarkdown('# Title\n\ntext\n\n---\n\nmore');
    expect(html).not.toContain('doc-frontmatter');
    expect(html).toContain('<hr>');
  });

  it('escapes HTML inside frontmatter values', () => {
    const html = renderMarkdown('---\nx: <script>alert(1)</script>\n---\n\n# H');
    expect(html).not.toContain('<script>');
    expect(html).toContain('doc-frontmatter');
  });

  it('leaves a document without frontmatter unchanged', () => {
    const html = renderMarkdown('# Title\n\nBody.');
    expect(html).not.toContain('doc-frontmatter');
  });

  it('drops an empty frontmatter block instead of rendering an empty box', () => {
    expect(renderMarkdown('---\n---\n\n# H')).not.toContain('doc-frontmatter');
    expect(renderMarkdown('---\n\n---\n\n# H')).not.toContain('doc-frontmatter');
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
    expect(html).toContain(`src="/api/asset?path=${encodeURIComponent('/abs/dir/diagram.png')}"`);
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
    expect(html).toContain(`src="/api/asset?path=${encodeURIComponent('/abs/img.png')}"`);
  });

  it('preserves data: URI images through the sanitizer', () => {
    const md = '![diagram](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==)';
    const html = renderMarkdown(md);
    expect(html).toContain('src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="');
    expect(html).toContain('alt="diagram"');
  });

  it('opens external links in a new tab through the full pipeline', () => {
    const md = '[ext](https://example.com)';
    const html = renderMarkdown(md);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderMarkdown table scroll wrapping (rehypeWrapTables)', () => {
  it('wraps a table in div.table-scroll > div.table-scroll__viewport > table', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toMatch(
      /<div class="table-scroll"><div class="table-scroll__viewport"><table[^>]*>/,
    );
    expect(html).toContain('</table></div></div>');
  });

  it('wraps multiple sibling tables independently, dropping none and nesting none', () => {
    const md = '| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |';
    const html = renderMarkdown(md);
    // Every table is wrapped exactly once (2 viewports for 2 tables).
    expect((html.match(/table-scroll__viewport/g) ?? []).length).toBe(2);
    expect((html.match(/<table[^>]*>/g) ?? []).length).toBe(2);
    // The SKIP/index+1 visitor must not descend into a wrapper it just
    // inserted: a nested wrap would splice a second .table-scroll straight
    // inside a viewport.
    expect(html).not.toContain('table-scroll__viewport"><div class="table-scroll"');
  });

  it('wraps a table nested inside a blockquote', () => {
    const md = '> | A |\n> | --- |\n> | 1 |';
    const html = renderMarkdown(md);
    expect(html).toMatch(/<blockquote[^>]*>/);
    expect(html).toMatch(
      /<div class="table-scroll"><div class="table-scroll__viewport"><table[^>]*>/,
    );
  });

  it('leaves content without tables unwrapped', () => {
    const html = renderMarkdown('Just a paragraph, no table.');
    expect(html).not.toContain('table-scroll');
  });
});
