import { describe, it, expect } from 'vitest';
import { buildHighlightedHtml, escapeHtml, extractRawHeadings } from './RawView';

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('does not double-escape', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('buildHighlightedHtml', () => {
  describe('plain text', () => {
    it('returns escaped plain text when no syntax matches', () => {
      const html = buildHighlightedHtml('Just some plain text.');
      expect(html).toBe('Just some plain text.');
    });

    it('preserves empty lines', () => {
      const html = buildHighlightedHtml('line1\n\nline3');
      expect(html).toBe('line1\n\nline3');
    });
  });

  describe('headings', () => {
    it('highlights ATX headings', () => {
      const html = buildHighlightedHtml('# Hello World');
      expect(html).toContain('class="raw-heading"');
      expect(html).toContain('# Hello World');
    });

    it('highlights h2-h6', () => {
      for (const prefix of ['##', '###', '####', '#####', '######']) {
        const html = buildHighlightedHtml(`${prefix} Heading`);
        expect(html).toContain('class="raw-heading"');
      }
    });

    it('does not highlight # without space', () => {
      const html = buildHighlightedHtml('#nospace');
      expect(html).not.toContain('raw-heading');
    });
  });

  describe('bold and italic', () => {
    it('highlights bold text', () => {
      const html = buildHighlightedHtml('**bold text**');
      expect(html).toContain('class="raw-bold"');
      expect(html).toContain('**bold text**');
    });

    it('highlights italic text', () => {
      const html = buildHighlightedHtml('*italic text*');
      expect(html).toContain('class="raw-italic"');
    });

    it('does not highlight bold as italic', () => {
      const html = buildHighlightedHtml('**bold** *italic*');
      // Bold should be matched, not italic within bold
      expect(html).toContain('raw-bold');
      expect(html).toContain('raw-italic');
    });
  });

  describe('inline code', () => {
    it('highlights inline code', () => {
      const html = buildHighlightedHtml('Use `console.log()` here');
      expect(html).toContain('class="raw-inline-code"');
      expect(html).toContain('`console.log()`');
    });
  });

  describe('links', () => {
    it('highlights markdown links', () => {
      const html = buildHighlightedHtml('[click here](https://example.com)');
      expect(html).toContain('class="raw-link"');
    });
  });

  describe('blockquotes', () => {
    it('highlights blockquote lines', () => {
      const html = buildHighlightedHtml('> This is a quote');
      expect(html).toContain('class="raw-blockquote"');
    });
  });

  describe('horizontal rules', () => {
    it('highlights --- as HR', () => {
      const html = buildHighlightedHtml('---');
      expect(html).toContain('class="raw-hr"');
    });

    it('highlights ---- (4+ dashes) as HR', () => {
      const html = buildHighlightedHtml('----');
      expect(html).toContain('class="raw-hr"');
    });

    it('highlights *** as HR', () => {
      const html = buildHighlightedHtml('***');
      expect(html).toContain('class="raw-hr"');
    });
  });

  describe('tables', () => {
    it('highlights table rows', () => {
      const html = buildHighlightedHtml('| A | B |\n|---|---|\n| 1 | 2 |');
      expect(html).toContain('class="raw-table"');
    });
  });

  describe('frontmatter', () => {
    it('highlights YAML frontmatter at start of file', () => {
      const html = buildHighlightedHtml('---\ntitle: Hello\n---\n# Content');
      expect(html).toContain('class="raw-frontmatter"');
      expect(html).toContain('class="raw-heading"');
    });

    it('does not highlight --- in middle of file as frontmatter', () => {
      const html = buildHighlightedHtml('# Title\n\n---\n\nMore text');
      // The --- should be an HR, not frontmatter
      expect(html).not.toContain('raw-frontmatter');
    });
  });

  describe('comment markers', () => {
    const marker = '<!-- @comment{"id":"abc","anchor":"hello","text":"fix this","author":"User","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->';

    it('highlights comment markers', () => {
      const html = buildHighlightedHtml(`Some text ${marker}hello world`);
      expect(html).toContain('class="raw-comment-marker"');
    });

    it('adds data-comment-id attribute', () => {
      const html = buildHighlightedHtml(`${marker}hello`);
      expect(html).toContain('data-comment-id="abc"');
    });

    it('handles multiline comment markers', () => {
      // Use \\n in JSON (escaped newline) so JSON.parse succeeds — this is how the app serializes them
      const multilineMarker = '<!-- @comment{"id":"m1","anchor":"test","text":"long\\ncomment","author":"User","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->';
      const html = buildHighlightedHtml(`before ${multilineMarker}after`);
      expect(html).toContain('data-comment-id="m1"');
      expect(html).toContain('raw-comment-marker');
    });

    it('gives comment markers priority over bold', () => {
      // When bold wraps around a comment marker: **<!-- @comment{...} -->text**
      const raw = `**${marker}hello world**`;
      const html = buildHighlightedHtml(raw);
      // Comment marker should be highlighted, not swallowed by bold
      expect(html).toContain('raw-comment-marker');
      expect(html).toContain('data-comment-id="abc"');
    });

    it('gives comment markers priority over headings', () => {
      const raw = `## ${marker}Section Title`;
      const html = buildHighlightedHtml(raw);
      expect(html).toContain('raw-comment-marker');
      expect(html).toContain('data-comment-id="abc"');
      // Heading should not overlap with the comment marker
      expect(html).not.toContain('raw-heading');
    });

    it('handles multiple comment markers', () => {
      const m1 = '<!-- @comment{"id":"c1","anchor":"a","text":"x","author":"U","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->';
      const m2 = '<!-- @comment{"id":"c2","anchor":"b","text":"y","author":"U","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->';
      const html = buildHighlightedHtml(`${m1}alpha ${m2}beta`);
      expect(html).toContain('data-comment-id="c1"');
      expect(html).toContain('data-comment-id="c2"');
    });
  });

  describe('overlap resolution', () => {
    it('first syntax match wins when two non-comment rules overlap', () => {
      // Inline code appears before bold in rule order
      // But if bold wraps inline code, the one that starts first wins
      const html = buildHighlightedHtml('**bold `code` more**');
      // Bold starts first, should capture everything
      expect(html).toContain('raw-bold');
    });

    it('does not apply syntax highlighting inside comment markers', () => {
      const marker = '<!-- @comment{"id":"x","anchor":"# heading","text":"fix","author":"U","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->';
      const html = buildHighlightedHtml(marker);
      // The "# heading" inside the JSON should not be highlighted as a heading
      expect(html).not.toContain('raw-heading');
      expect(html).toContain('raw-comment-marker');
    });
  });

  describe('HTML escaping in output', () => {
    it('escapes HTML entities in plain text', () => {
      const html = buildHighlightedHtml('a < b & c > d');
      expect(html).toContain('&lt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&gt;');
    });

    it('escapes HTML inside highlighted spans', () => {
      const html = buildHighlightedHtml('## Title <script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

describe('extractRawHeadings', () => {
  it('extracts headings with stable slug ids and line indexes', () => {
    const headings = extractRawHeadings('# Title\n\n## Section One\n\n## Section One\n');
    expect(headings).toEqual([
      { id: 'title', text: 'Title', level: 1, lineIndex: 0 },
      { id: 'section-one', text: 'Section One', level: 2, lineIndex: 2 },
      { id: 'section-one-1', text: 'Section One', level: 2, lineIndex: 4 },
    ]);
  });

  it('ignores inline comment markers when matching heading lines', () => {
    const headings = extractRawHeadings(
      '# Intro\n\n## <!-- @comment{"id":"c1","anchor":"Heading","text":"Fix","author":"U","timestamp":"2026-01-01T00:00:00Z","replies":[]} -->Heading\n',
    );
    expect(headings).toEqual([
      { id: 'intro', text: 'Intro', level: 1, lineIndex: 0 },
      { id: 'heading', text: 'Heading', level: 2, lineIndex: 2 },
    ]);
  });
});
