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

describe('renderMarkdown keepLineBreaks', () => {
  const md = '**Actor:** the creator.\n**Trigger:** what now?';
  const textOf = (html: string) => html.replace(/<[^>]+>/g, '');

  it('joins soft-broken lines by default, as CommonMark does', () => {
    expect(renderMarkdown(md)).not.toContain('<br>');
  });

  it('turns each single newline into a line break when on', () => {
    const html = renderMarkdown(md, undefined, { keepLineBreaks: true });
    expect(html).toContain('the creator.<br>\n<strong>Trigger:</strong>');
  });

  it('leaves the text that comment anchoring searches unchanged', () => {
    expect(textOf(renderMarkdown(md, undefined, { keepLineBreaks: true }))).toBe(
      textOf(renderMarkdown(md)),
    );
  });

  it('does not touch fenced code', () => {
    const fenced = '```\nline one\nline two\n```';
    expect(renderMarkdown(fenced, undefined, { keepLineBreaks: true })).toBe(
      renderMarkdown(fenced),
    );
  });

  it('keeps the source span a whole-paragraph copy slices by', () => {
    expect(renderMarkdown(md, undefined, { keepLineBreaks: true })).toContain(
      `data-src-start="0" data-src-end="${md.length}"`,
    );
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

describe('renderMarkdown HTML comments (rehypeRenderHtmlComments)', () => {
  // Decode the handful of entities rehype-stringify emits in text content, so a
  // rendered body can be compared byte-for-byte against the source inner text.
  const decode = (s: string): string =>
    s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

  // The wrapper's real content is the comment body; the <!-- / --> delimiters
  // are CSS chrome and never appear in the HTML. Pull the span's text back out
  // and decode it to recover the verbatim body.
  const body = (html: string): string => {
    const m = /<span class="doc-html-comment[^"]*">([\s\S]*?)<\/span>/.exec(html);
    if (!m) throw new Error(`no .doc-html-comment span in: ${html}`);
    return decode(m[1]);
  };

  const on = { renderHtmlComments: true } as const;

  it('renders an ordinary comment as a muted span, delimiters as CSS chrome', () => {
    const html = renderMarkdown('<!-- a note to the next reader -->', undefined, on);
    expect(html).toContain('class="doc-html-comment');
    // Delimiters are never text — they come from ::before / ::after.
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('-->');
  });

  it('emits the body verbatim: leading and trailing spaces', () => {
    // Source inner value is ` a note ` (a space each side of the text).
    expect(body(renderMarkdown('<!-- a note -->', undefined, on))).toBe(' a note ');
  });

  it('emits the body verbatim: an empty comment', () => {
    expect(body(renderMarkdown('<!---->', undefined, on))).toBe('');
  });

  it('emits the body verbatim: no surrounding spaces (<!--x-->)', () => {
    expect(body(renderMarkdown('<!--x-->', undefined, on))).toBe('x');
  });

  it('strips only the delimiter-adjacent whitespace from a multi-line body', () => {
    // The space after `<!--` and the newline before `-->` are separators, not
    // content. With the delimiters rendered on their own lines they would show
    // as a stray indent on line one and a blank line at the foot -- breaking
    // exactly the column alignment this variant exists to preserve.
    expect(body(renderMarkdown('<!-- line one\nline two -->', undefined, on))).toBe(
      'line one\nline two',
    );
  });

  it('strips a leading newline when the body opens on its own line', () => {
    expect(body(renderMarkdown('<!--\nline one\nline two\n-->', undefined, on))).toBe(
      'line one\nline two',
    );
  });

  it('leaves interior indentation of a multi-line body untouched', () => {
    // Only the edges are separators. Anything a writer aligned inside the block
    // is content, and losing it would defeat the point.
    expect(body(renderMarkdown('<!-- $ cmd\n    indented\n\ttabbed -->', undefined, on))).toBe(
      '$ cmd\n    indented\n\ttabbed',
    );
  });

  it('emits the body verbatim: a literal <!-- inside the body', () => {
    // The first --> closes the comment, so `<!--` inside is just body text.
    expect(body(renderMarkdown('<!-- a <!-- b -->', undefined, on))).toBe(' a <!-- b ');
  });

  it('marks a standalone comment (parent root) as a block', () => {
    const html = renderMarkdown('<!-- standalone -->', undefined, on);
    expect(html).toContain('class="doc-html-comment doc-html-comment--block"');
    // A block comment is not wrapped in a paragraph.
    // `<p[^>]*>` rather than `<p>`: rehypeAnnotateSource (0.9.0) writes
    // data-src-start/data-src-end onto block elements, so a literal `<p>` no
    // longer appears. On a NEGATIVE assertion that difference is silent — the
    // pattern stops matching anything and the test passes vacuously.
    expect(html).not.toMatch(/<p[^>]*>[^<]*<span class="doc-html-comment/);
  });

  it('renders an inline comment (parent <p>) as an inline span, no --block', () => {
    const html = renderMarkdown('Text before <!-- inline note --> text after.', undefined, on);
    expect(html).toMatch(/<p[^>]*>Text before <span class="doc-html-comment">/);
    expect(html).not.toContain('doc-html-comment--block');
    // The former double-space is gone: single spaces flank the visible comment.
    expect(html).toContain('Text before <span');
    expect(html).toContain('</span> text after.');
  });

  it('renders a comment after text in a tight list item inline', () => {
    const html = renderMarkdown('- An item. <!-- a note -->', undefined, on);
    expect(html).toContain('<span class="doc-html-comment">');
    expect(html).not.toContain('doc-html-comment--block');
  });

  it('marks consecutive standalone comments as blocks', () => {
    const html = renderMarkdown('<!-- first -->\n<!-- second -->', undefined, on);
    expect(html.match(/doc-html-comment--block/g)).toHaveLength(2);
  });

  it('marks a multi-line comment as preformatted', () => {
    // A comment whose body spans lines carries meaning in its line breaks and
    // column alignment -- a command over its output, a table. Rendered as
    // prose those collapse to single spaces and the signal is gone.
    const html = renderMarkdown('<!-- line one\nline two -->', undefined, on);
    expect(html).toContain('doc-html-comment--pre');
  });

  it('leaves a single-line standalone comment as an ordinary block', () => {
    const html = renderMarkdown('<!-- standalone -->', undefined, on);
    expect(html).not.toContain('doc-html-comment--pre');
  });

  it('marks a multi-line comment inside a paragraph as preformatted', () => {
    // Phrasing context does not make the line breaks meaningless.
    const html = renderMarkdown('Text before <!-- one\ntwo --> after.', undefined, on);
    expect(html).toContain('doc-html-comment--pre');
  });

  it('keeps every source line of a multi-line comment separate in the output', () => {
    // The regression this guards: the newlines are in the DOM but CSS collapses
    // them, so what the reader sees -- and what a selection anchor records -- is
    // one joined line. The markup half of the fix is asserted here; the
    // white-space rule that makes it visible lives in index.css.
    const source = '<!-- $ echo hi\nhi -->';
    expect(body(renderMarkdown(source, undefined, on))).toBe('$ echo hi\nhi');
  });

  it('keeps a malformed @comment marker hidden', () => {
    // A well-formed marker never reaches the renderer (parseComments strips it);
    // a malformed one that survived stripping must not render as a note.
    const html = renderMarkdown('<!-- @comment{"id":"x" -->', undefined, on);
    expect(html).not.toContain('doc-html-comment');
    expect(html).not.toContain('@comment');
  });

  it('keeps a well-formed @comment marker hidden', () => {
    const marker = '<!-- @comment{"id":"1","anchor":"a","text":"b"} -->';
    const html = renderMarkdown(marker, undefined, on);
    expect(html).not.toContain('doc-html-comment');
    expect(html).not.toContain('@comment');
  });

  it('drops ordinary comments by default (option off), leaving callers unchanged', () => {
    expect(renderMarkdown('<!-- a note -->')).not.toContain('doc-html-comment');
    expect(renderMarkdown('Text <!-- a note --> more')).not.toContain('doc-html-comment');
  });

  it('drops ordinary comments when the option is explicitly false', () => {
    const html = renderMarkdown('<!-- a note -->', undefined, { renderHtmlComments: false });
    expect(html).not.toContain('doc-html-comment');
  });

  describe('hiddenCommentPrefixes', () => {
    it('hides a comment whose body starts with a listed prefix', () => {
      const html = renderMarkdown('<!-- prettier-ignore -->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['prettier-ignore'],
      });
      expect(html).not.toContain('doc-html-comment');
    });

    it('matches after trimStart, so the unspaced writer form is caught too', () => {
      // remark-lint writes `<!--lint disable-->`; prettier writes
      // `<!-- prettier-ignore -->`. One prefix has to cover both.
      const spaced = renderMarkdown('<!-- lint disable -->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['lint disable'],
      });
      const unspaced = renderMarkdown('<!--lint disable-->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['lint disable'],
      });
      expect(spaced).not.toContain('doc-html-comment');
      expect(unspaced).not.toContain('doc-html-comment');
    });

    it('still renders a comment that merely CONTAINS a listed prefix', () => {
      // Prefix-only, deliberately: a note discussing a directive is still a
      // note, and substring matching would swallow it.
      const html = renderMarkdown('<!-- we should add prettier-ignore here -->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['prettier-ignore'],
      });
      expect(body(html)).toBe(' we should add prettier-ignore here ');
    });

    it('matches a prefix only as a whole word', () => {
      const opts = { ...on, hiddenCommentPrefixes: ['more', 'toc'] };
      expect(renderMarkdown('<!-- more -->', undefined, opts)).not.toContain('doc-html-comment');
      expect(renderMarkdown('<!-- more on this later -->', undefined, opts)).not.toContain(
        'doc-html-comment',
      );
      expect(body(renderMarkdown('<!-- moreover, a note -->', undefined, opts))).toBe(
        ' moreover, a note ',
      );
      expect(body(renderMarkdown('<!-- tocopherol -->', undefined, opts))).toBe(' tocopherol ');
    });

    it('treats a hyphen as a word boundary', () => {
      const html = renderMarkdown('<!-- markdownlint-disable-next-line MD033 -->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['markdownlint-disable'],
      });
      expect(html).not.toContain('doc-html-comment');
    });

    it('lets a prefix ending in punctuation match whatever follows it', () => {
      const html = renderMarkdown('<!-- cSpell:ignore mdr -->', undefined, {
        ...on,
        hiddenCommentPrefixes: ['cSpell:'],
      });
      expect(html).not.toContain('doc-html-comment');
    });

    it('renders every comment when the list is empty', () => {
      const html = renderMarkdown('<!-- prettier-ignore -->', undefined, {
        ...on,
        hiddenCommentPrefixes: [],
      });
      expect(html).toContain('doc-html-comment');
    });

    it('ignores the list when rendering is off', () => {
      const html = renderMarkdown('<!-- a note -->', undefined, {
        renderHtmlComments: false,
        hiddenCommentPrefixes: ['a note'],
      });
      expect(html).not.toContain('doc-html-comment');
    });

    it('hides a directive but not the prose beside it', () => {
      const html = renderMarkdown(
        '<!-- markdownlint-disable MD013 -->\n\nReal body.\n\n<!-- a genuine note -->',
        undefined,
        { ...on, hiddenCommentPrefixes: ['markdownlint-disable'] },
      );
      expect(html).toContain('Real body.');
      expect(body(html)).toBe(' a genuine note ');
      expect(html).not.toContain('MD013');
    });
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
