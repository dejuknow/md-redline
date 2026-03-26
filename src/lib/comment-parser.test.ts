import { describe, it, expect } from 'vitest';
import {
  parseComments,
  insertComment,
  removeComment,
  editComment,
  updateCommentAnchor,
  addReply,
  serializeComment,
  detectMissingAnchors,
  stripInlineFormatting,
  pickBestOccurrence,
} from './comment-parser';
import type { MdComment } from '../types';

// Helper to make a comment marker
function marker(overrides: Partial<MdComment> = {}): string {
  const comment: MdComment = {
    id: overrides.id ?? 'test-id',
    anchor: overrides.anchor ?? 'hello',
    text: overrides.text ?? 'my comment',
    author: overrides.author ?? 'User',
    timestamp: overrides.timestamp ?? '2024-01-01T00:00:00.000Z',
    replies: overrides.replies,
    ...overrides,
  };
  return serializeComment(comment);
}

describe('parseComments', () => {
  it('returns empty results for plain markdown', () => {
    const result = parseComments('# Hello\n\nSome text');
    expect(result.comments).toHaveLength(0);
    expect(result.cleanMarkdown).toBe('# Hello\n\nSome text');
  });

  it('extracts a single comment and strips its marker', () => {
    const raw = `Some ${marker({ anchor: 'text' })}text here`;
    const result = parseComments(raw);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].id).toBe('test-id');
    expect(result.comments[0].anchor).toBe('text');
    expect(result.cleanMarkdown).toBe('Some text here');
  });

  it('extracts multiple comments', () => {
    const raw = `${marker({ id: 'a', anchor: 'Hello' })}Hello ${marker({ id: 'b', anchor: 'world' })}world`;
    const result = parseComments(raw);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0].id).toBe('a');
    expect(result.comments[1].id).toBe('b');
    expect(result.cleanMarkdown).toBe('Hello world');
  });

  it('computes correct cleanOffset for each comment', () => {
    const raw = `${marker({ id: 'a', anchor: 'Hello' })}Hello ${marker({ id: 'b', anchor: 'world' })}world`;
    const result = parseComments(raw);
    expect(result.comments[0].cleanOffset).toBe(0);
    expect(result.comments[1].cleanOffset).toBe(6); // "Hello " is 6 chars
  });

  it('skips malformed comment markers', () => {
    const raw = '<!-- @comment{invalid json} -->Some text';
    const result = parseComments(raw);
    expect(result.comments).toHaveLength(0);
    expect(result.cleanMarkdown).toBe('Some text');
  });

  it('handles empty markdown', () => {
    const result = parseComments('');
    expect(result.comments).toHaveLength(0);
    expect(result.cleanMarkdown).toBe('');
  });

  it('cleanToRawOffset maps positions correctly', () => {
    const m = marker({ anchor: 'Hello' });
    const raw = `${m}Hello world`;
    const result = parseComments(raw);
    // Clean offset 0 should map to raw offset = marker length
    expect(result.cleanToRawOffset(0)).toBe(m.length);
    // Clean offset 5 ("Hello") should map to raw offset = marker length + 5
    expect(result.cleanToRawOffset(5)).toBe(m.length + 5);
  });

  it('handles comments with newlines in text (dotall regex)', () => {
    const comment: MdComment = {
      id: 'nl-test',
      anchor: 'hello',
      text: 'line one\nline two',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const m = serializeComment(comment);
    const raw = `${m}hello world`;
    const result = parseComments(raw);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('line one\nline two');
  });
});

describe('insertComment', () => {
  it('inserts a comment marker before the anchor text', () => {
    const raw = 'Hello world';
    const result = insertComment(raw, 'world', 'fix this');
    expect(result).toContain('<!-- @comment');
    expect(result).toContain('"anchor":"world"');
    expect(result).toContain('"text":"fix this"');
    // The marker should appear before "world"
    const markerIdx = result.indexOf('<!-- @comment');
    const worldIdx = result.indexOf('world', markerIdx);
    expect(markerIdx).toBeLessThan(worldIdx);
  });

  it('returns raw markdown unchanged when anchor not found', () => {
    const raw = 'Hello world';
    const result = insertComment(raw, 'nonexistent', 'comment');
    expect(result).toBe(raw);
  });

  it('works with anchor text containing markdown formatting', () => {
    const raw = '# Heading\n\nSome **bold** text';
    const result = insertComment(raw, 'bold', 'needs italic');
    expect(result).toContain('"anchor":"bold"');
  });

  it('does not break existing comments', () => {
    const raw = `${marker({ id: 'existing' })}hello world`;
    const result = insertComment(raw, 'world', 'new comment');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.comments.find((c) => c.id === 'existing')).toBeTruthy();
  });

  it('handles duplicate anchor text (first match)', () => {
    const raw = 'hello hello hello';
    const result = insertComment(raw, 'hello', 'which one?');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe('hello hello hello');
  });

  it('uses hintOffset to disambiguate duplicate anchor text', () => {
    const raw = 'foo bar foo bar foo';
    // "foo" appears at clean offsets 0, 8, 16; hintOffset=15 is closest to 16
    const result = insertComment(raw, 'foo', 'third one', 'User', undefined, undefined, 15);
    // The marker should be inserted before the third "foo", not the first
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('foo bar foo bar ');
  });

  it('uses hintOffset to select second occurrence of duplicate text', () => {
    const raw = 'The cat sat. The cat played.';
    // "The cat" appears at offsets 0 and 13; hintOffset=13 should pick the second
    const result = insertComment(raw, 'The cat', 'second one', 'User', undefined, undefined, 13);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('The cat sat. ');
  });

  it('uses hintOffset to disambiguate duplicate cross-element selections', () => {
    // Anchor spans a newline, which triggers the segment-based fallback.
    // The same two-line pattern repeats, so hintOffset must disambiguate.
    const raw = 'hello\nworld\n\nhello\nworld';
    // Segments: ["hello", "world"]. Appear at clean offsets 0 and 13.
    // In plain text (same as clean here, no formatting), also at 0 and 13.
    // hintOffset=13 should pick the second occurrence.
    const result = insertComment(raw, 'hello\nworld', 'second', 'User', undefined, undefined, 13);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('hello\nworld\n\n');
  });

  it('uses hintOffset when one occurrence is formatted and the other is not', () => {
    // **foo**\nbar\n\nfoo\nbar — only "foo\nbar" at position 13 is an exact match
    // in clean markdown; the first occurrence is inside **foo** so indexOf misses it.
    // hintOffset=0 (plain text position of first "foo") should pick the formatted one.
    const raw = '**foo**\nbar\n\nfoo\nbar';
    const result = insertComment(raw, 'foo', 'first one', 'User', undefined, undefined, 0);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    // Marker should be before "foo" inside **foo** (after the ** formatting prefix)
    expect(textBefore).toBe('**');
  });

  it('uses hintOffset in plain-text space to handle formatted duplicates', () => {
    // **foo** x foo — clean markdown has "foo" at offsets 2 and 10,
    // but rendered/plain text has "foo" at offsets 0 and 6.
    // Selecting second "foo" gives hintOffset=6 (plain-text space).
    const raw = '**foo** x foo';
    const result = insertComment(raw, 'foo', 'second one', 'User', undefined, undefined, 6);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    // Marker should be before the second "foo" (after "**foo** x ")
    expect(textBefore).toBe('**foo** x ');
  });
});

describe('removeComment', () => {
  it('removes a comment by id', () => {
    const raw = `${marker({ id: 'del-me' })}hello world`;
    const result = removeComment(raw, 'del-me');
    expect(result).toBe('hello world');
  });

  it('leaves other comments intact', () => {
    const raw = `${marker({ id: 'a' })}hello ${marker({ id: 'b' })}world`;
    const result = removeComment(raw, 'a');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].id).toBe('b');
  });

  it('does nothing when id not found', () => {
    const raw = `${marker({ id: 'a' })}hello`;
    const result = removeComment(raw, 'nonexistent');
    expect(result).toBe(raw);
  });
});

describe('editComment', () => {
  it('updates the comment text', () => {
    const raw = `${marker({ id: 'e1', text: 'old text' })}hello`;
    const result = editComment(raw, 'e1', 'new text');
    const parsed = parseComments(result);
    expect(parsed.comments[0].text).toBe('new text');
  });

  it('does not change other fields', () => {
    const raw = `${marker({ id: 'e1', text: 'old', author: 'Alice' })}hello`;
    const result = editComment(raw, 'e1', 'new');
    const parsed = parseComments(result);
    expect(parsed.comments[0].author).toBe('Alice');
    expect(parsed.comments[0].id).toBe('e1');
  });
});

describe('updateCommentAnchor', () => {
  it('updates the anchor text', () => {
    const raw = `${marker({ id: 'a1', anchor: 'old anchor' })}old anchor text`;
    const result = updateCommentAnchor(raw, 'a1', 'new anchor');
    const parsed = parseComments(result);
    expect(parsed.comments[0].anchor).toBe('new anchor');
  });
});

describe('addReply', () => {
  it('adds a reply to an existing comment', () => {
    const raw = `${marker({ id: 'rp1' })}hello`;
    const result = addReply(raw, 'rp1', 'reply text', 'Bob');
    const parsed = parseComments(result);
    expect(parsed.comments[0].replies).toHaveLength(1);
    expect(parsed.comments[0].replies![0].text).toBe('reply text');
    expect(parsed.comments[0].replies![0].author).toBe('Bob');
  });

  it('appends to existing replies', () => {
    const raw = `${marker({ id: 'rp1', replies: [{ id: 'r1', text: 'first', author: 'A', timestamp: '2024-01-01T00:00:00.000Z' }] })}hello`;
    const result = addReply(raw, 'rp1', 'second', 'B');
    const parsed = parseComments(result);
    expect(parsed.comments[0].replies).toHaveLength(2);
    expect(parsed.comments[0].replies![1].text).toBe('second');
  });
});

describe('serializeComment', () => {
  it('produces a valid comment marker', () => {
    const comment: MdComment = {
      id: 'ser-1',
      anchor: 'test',
      text: 'a comment',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const result = serializeComment(comment);
    expect(result).toMatch(/^<!-- @comment\{.*\} -->$/);
    const parsed = parseComments(result + 'test');
    expect(parsed.comments[0].id).toBe('ser-1');
  });

  it('strips cleanOffset from serialization', () => {
    const comment: MdComment = {
      id: 'ser-2',
      anchor: 'test',
      text: 'comment',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      cleanOffset: 42,
    };
    const result = serializeComment(comment);
    expect(result).not.toContain('cleanOffset');
  });
});

describe('edge cases', () => {
  it('handles special characters in comment text', () => {
    const raw = insertComment('Hello world', 'world', 'has "quotes" and <angle> brackets');
    const parsed = parseComments(raw);
    expect(parsed.comments[0].text).toBe('has "quotes" and <angle> brackets');
  });

  it('handles overlapping anchors (multiple comments on same text)', () => {
    let raw = 'Hello world';
    raw = insertComment(raw, 'Hello', 'comment 1');
    raw = insertComment(raw, 'Hello', 'comment 2');
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.cleanMarkdown).toBe('Hello world');
  });

  it('handles very long anchor text', () => {
    const longText = 'a'.repeat(10000);
    const raw = `Start ${longText} end`;
    const result = insertComment(raw, longText, 'comment on long text');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe(`Start ${longText} end`);
  });

  it('round-trips: parse then re-serialize preserves comments', () => {
    const raw = `${marker({ id: 'rt1', text: 'hello' })}some text ${marker({ id: 'rt2', text: 'world' })}more text`;
    const { comments, cleanMarkdown } = parseComments(raw);
    // Re-insert comments back
    let rebuilt = cleanMarkdown;
    for (const c of comments.reverse()) {
      const m = serializeComment(c);
      const offset = c.cleanOffset ?? 0;
      rebuilt = rebuilt.slice(0, offset) + m + rebuilt.slice(offset);
    }
    const reparsed = parseComments(rebuilt);
    expect(reparsed.comments).toHaveLength(2);
    expect(reparsed.cleanMarkdown).toBe(cleanMarkdown);
  });
});

describe('detectMissingAnchors', () => {
  it('returns empty set when all anchors are present', () => {
    const clean = 'Hello world, this is a test';
    const comments = [
      { id: 'a', anchor: 'Hello world' },
      { id: 'b', anchor: 'this is a test' },
    ] as MdComment[];
    expect(detectMissingAnchors(clean, comments).size).toBe(0);
  });

  it('detects when anchor text is completely removed', () => {
    const clean = 'Hello world';
    const comments = [{ id: 'a', anchor: 'deleted text' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(true);
  });

  it('does not flag anchors with flexible whitespace match', () => {
    const clean = 'Hello\nworld';
    const comments = [{ id: 'a', anchor: 'Hello world' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('detects partially modified anchor', () => {
    const clean = 'Hello universe';
    const comments = [{ id: 'a', anchor: 'Hello world' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(true);
  });

  it('handles empty anchor gracefully', () => {
    const clean = 'Hello world';
    const comments = [{ id: 'a', anchor: '' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('handles whitespace-only anchor gracefully', () => {
    const clean = 'Hello world';
    const comments = [{ id: 'a', anchor: '   ' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('identifies multiple missing anchors', () => {
    const clean = 'Only this remains';
    const comments = [
      { id: 'a', anchor: 'gone text' },
      { id: 'b', anchor: 'also gone' },
      { id: 'c', anchor: 'Only this remains' },
    ] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.size).toBe(2);
    expect(missing.has('a')).toBe(true);
    expect(missing.has('b')).toBe(true);
    expect(missing.has('c')).toBe(false);
  });

  it('flags anchor when words appear non-contiguously in different sections', () => {
    const clean = 'API is great\n\nSome other stuff\n\ndesign guidelines here';
    const comments = [{ id: 'a', anchor: 'API design guidelines' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(true);
  });

  it('does not flag anchor when words appear contiguously with extra whitespace', () => {
    const clean = 'API  design\n\tguidelines';
    const comments = [{ id: 'a', anchor: 'API design guidelines' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('returns empty set for empty markdown', () => {
    const comments = [{ id: 'a', anchor: 'test' }] as MdComment[];
    expect(detectMissingAnchors('', comments).size).toBe(0);
  });

  it('handles contiguous match at second occurrence', () => {
    const clean = 'API stuff\n\nAPI design guidelines here';
    const comments = [{ id: 'a', anchor: 'API design guidelines' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning across list items', () => {
    const clean = '- System sends verification email within 30 seconds\n- User cannot access protected routes';
    const comments = [{ id: 'a', anchor: 'System sends verification email within 30 seconds\nUser cannot acce' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning across blockquote lines', () => {
    const clean = '> First line of quote\n> Second line continues';
    const comments = [{ id: 'a', anchor: 'First line of quote\nSecond line continues' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning bold formatting', () => {
    const clean = 'the **initial** implementation is ready';
    const comments = [{ id: 'a', anchor: 'initial implementation' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning italic with underscores', () => {
    const clean = 'the _initial_ implementation is ready';
    const comments = [{ id: 'a', anchor: 'initial implementation' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning inline code', () => {
    const clean = 'use `myFunction` to process data';
    const comments = [{ id: 'a', anchor: 'use myFunction to process' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning strikethrough', () => {
    const clean = 'the ~~old~~ new approach works';
    const comments = [{ id: 'a', anchor: 'old new approach' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning mixed formatting', () => {
    const clean = '> *Note: This is **important** and _critical_ for the `release` process.*';
    const comments = [{ id: 'a', anchor: 'Note: This is important and critical for the release process.' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor spanning link syntax', () => {
    const clean = 'See [the docs](https://example.com) for details';
    const comments = [{ id: 'a', anchor: 'See the docs for details' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor from rendered mermaid diagram text', () => {
    const clean = '# Flow\n\n```mermaid\ngraph TD\n    A[Admin clicks Add] --> B[Admin enters name]\n```\n';
    const comments = [{ id: 'a', anchor: "clicks Add Admin enters" }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag single-node mermaid anchor', () => {
    const clean = '```mermaid\ngraph TD\n    A[User submits form]\n```\n';
    const comments = [{ id: 'a', anchor: 'User submits form' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor from mermaid edge label', () => {
    const clean = '```mermaid\ngraph TD\n    A -->|Yes| B -->|No| C\n```\n';
    const comments = [{ id: 'a', anchor: 'Yes' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('does not flag anchor in mermaid when file also has regular markdown', () => {
    const clean = '# Title\n\nSome **bold** paragraph.\n\n```mermaid\ngraph TD\n    A[User clicks button]\n```\n\nMore text here.\n';
    const comments = [{ id: 'a', anchor: 'User clicks button' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
  });

  it('matches across multiple mermaid blocks', () => {
    const clean = '```mermaid\ngraph TD\n    A[First]\n```\n\nText\n\n```mermaid\ngraph TD\n    B[Second]\n```\n';
    const comments = [
      { id: 'a', anchor: 'First' },
      { id: 'b', anchor: 'Second' },
    ] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(false);
    expect(missing.has('b')).toBe(false);
  });

  it('flags truly missing anchor even with mermaid blocks present', () => {
    const clean = '```mermaid\ngraph TD\n    A[Step one]\n```\n';
    const comments = [{ id: 'a', anchor: 'completely unrelated text' }] as MdComment[];
    const missing = detectMissingAnchors(clean, comments);
    expect(missing.has('a')).toBe(true);
  });
});

describe('insertComment with formatted markdown (stripInlineFormatting)', () => {
  it('finds anchor inside bold formatting', () => {
    const raw = 'This has **important** details';
    const result = insertComment(raw, 'important', 'why bold?');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].anchor).toBe('important');
  });

  it('finds anchor inside italic formatting', () => {
    const raw = 'This has *emphasized* text';
    const result = insertComment(raw, 'emphasized', 'noted');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('finds anchor inside heading', () => {
    const raw = '## My Heading\n\nSome body text';
    const result = insertComment(raw, 'My Heading', 'rename this');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('finds anchor in list items', () => {
    const raw = '- first item\n- second item\n- third item';
    const result = insertComment(raw, 'second item', 'check this');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('finds anchor in numbered list', () => {
    const raw = '1. alpha\n2. beta\n3. gamma';
    const result = insertComment(raw, 'beta', 'review');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('finds anchor with backtick code', () => {
    const raw = 'Use `myFunction` here';
    const result = insertComment(raw, 'myFunction', 'rename');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('handles cross-element anchor with newlines', () => {
    const raw = 'First line\nSecond line\nThird line';
    const result = insertComment(raw, 'First line\nSecond line', 'spans lines');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });
});

describe('insertComment with context', () => {
  it('stores contextBefore and contextAfter in the comment marker', () => {
    const raw = 'Some text before the anchor text and after text.';
    const result = insertComment(raw, 'anchor text', 'my note', 'User', 'before the ', ' and after');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].contextBefore).toBe('before the ');
    expect(parsed.comments[0].contextAfter).toBe(' and after');
  });

  it('works without context (backward compat)', () => {
    const raw = 'Hello world';
    const result = insertComment(raw, 'world', 'note');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].contextBefore).toBeUndefined();
    expect(parsed.comments[0].contextAfter).toBeUndefined();
  });
});

describe('fuzzy re-matching', () => {
  it('re-matches when anchor text has been rewritten but context remains', () => {
    // Simulate: comment was created on "old anchor" with context, then the text was changed
    const comment: MdComment = {
      id: 'fuzzy-1',
      anchor: 'old anchor text',
      text: 'rewrite this',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'before the ',
      contextAfter: ' and after',
    };
    // The raw markdown has the comment marker, but the anchor text has changed
    const raw = `before the ${serializeComment(comment)}new rewritten text and after that.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    // The cleanOffset should point to where "new rewritten text" starts
    const clean = parsed.cleanMarkdown;
    expect(clean).toBe('before the new rewritten text and after that.');
    // cleanOffset should be at position of "new rewritten text" (after "before the ")
    expect(parsed.comments[0].cleanOffset).toBe('before the '.length);
  });

  it('does not re-match when anchor is still found exactly', () => {
    const comment: MdComment = {
      id: 'exact-1',
      anchor: 'exact text',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'before ',
      contextAfter: ' after',
    };
    const raw = `before ${serializeComment(comment)}exact text after end.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    // cleanOffset should be at the exact position of "exact text"
    const clean = parsed.cleanMarkdown;
    expect(clean).toBe('before exact text after end.');
    expect(parsed.comments[0].cleanOffset).toBe('before '.length);
  });

  it('falls back gracefully when no context is stored (legacy comments)', () => {
    const comment: MdComment = {
      id: 'legacy-1',
      anchor: 'deleted text',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const raw = `completely different content ${serializeComment(comment)}here now.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    // cleanOffset should remain at the marker's original position
    expect(parsed.comments[0].cleanOffset).toBe('completely different content '.length);
  });

  it('falls back when context is also gone', () => {
    const comment: MdComment = {
      id: 'gone-1',
      anchor: 'vanished text',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'nonexistent before',
      contextAfter: 'nonexistent after',
    };
    const raw = `totally new content ${serializeComment(comment)}here.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    // cleanOffset stays at original position since fuzzy match failed
    expect(parsed.comments[0].cleanOffset).toBe('totally new content '.length);
  });

  it('uses contextBefore-only fallback when contextAfter is missing', () => {
    const comment: MdComment = {
      id: 'before-only-1',
      anchor: 'old text',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'the beginning of ',
    };
    const raw = `the beginning of ${serializeComment(comment)}new text here.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].cleanOffset).toBe('the beginning of '.length);
  });

  it('uses contextAfter-only fallback when contextBefore is missing', () => {
    const comment: MdComment = {
      id: 'after-only-1',
      anchor: 'old text',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextAfter: ' and the rest follows',
    };
    const raw = `prefix text ${serializeComment(comment)}changed text and the rest follows here.`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    const clean = parsed.cleanMarkdown;
    expect(clean).toBe('prefix text changed text and the rest follows here.');
    const afterIdx = clean.indexOf(' and the rest follows');
    // cleanOffset estimated as afterIdx - old anchor length
    expect(parsed.comments[0].cleanOffset).toBe(afterIdx - 'old text'.length);
  });

  it('rejects fuzzy match when gap between contexts is too large (>500 chars)', () => {
    const filler = 'x'.repeat(501);
    const comment: MdComment = {
      id: 'gap-1',
      anchor: 'old anchor',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'context before ',
      contextAfter: ' context after',
    };
    const raw = `context before ${serializeComment(comment)}${filler} context after end.`;
    const parsed = parseComments(raw);
    // Both-context match fails (gap > 500), contextBefore-only fallback succeeds
    expect(parsed.comments[0].cleanOffset).toBe('context before '.length);
  });

  it('does not re-match when context exists but gap is zero', () => {
    const comment: MdComment = {
      id: 'zero-gap-1',
      anchor: 'old anchor',
      text: 'note',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      contextBefore: 'before',
      contextAfter: 'after',
    };
    // Context is adjacent (gap = 0), so the both-context check fails (gap > 0 required)
    const raw = `before${serializeComment(comment)}after end.`;
    const parsed = parseComments(raw);
    // Falls through to contextBefore-only (length 6 < 10, skipped), then contextAfter-only (length 5 < 10, skipped)
    // cleanOffset stays at original marker position
    expect(parsed.comments[0].cleanOffset).toBe('before'.length);
  });
});

describe('insertComment with duplicate anchors', () => {
  it('inserts at the first occurrence when anchor appears multiple times', () => {
    const raw = 'foo bar foo baz foo';
    const result = insertComment(raw, 'foo', 'which foo?');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe('foo bar foo baz foo');
    expect(parsed.comments[0].cleanOffset).toBe(0);
  });
});

describe('insertComment cross-element segments', () => {
  it('handles cross-element anchor with duplicate segment text', () => {
    const raw = 'item one\nitem two\nitem three';
    const result = insertComment(raw, 'item one\nitem two', 'spans items');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe('item one\nitem two\nitem three');
    expect(parsed.comments[0].cleanOffset).toBe(0);
  });

  it('finds segments with tabs (table selections)', () => {
    const raw = 'Cell A\tCell B\tCell C';
    const result = insertComment(raw, 'Cell A\tCell B', 'spans cells');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].cleanOffset).toBe(0);
  });
});

describe('comments with nested JSON', () => {
  it('parses comments with replies containing braces in text', () => {
    const comment: MdComment = {
      id: 'nested-1',
      anchor: 'test',
      text: 'use {} syntax',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      replies: [
        { id: 'r1', text: 'try {value: true}', author: 'Bob', timestamp: '2024-01-01T00:00:00.000Z' },
      ],
    };
    const raw = `${serializeComment(comment)}test content`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].text).toBe('use {} syntax');
    expect(parsed.comments[0].replies).toHaveLength(1);
    expect(parsed.comments[0].replies![0].text).toBe('try {value: true}');
  });

  it('parses comments with deeply nested reply objects', () => {
    const comment: MdComment = {
      id: 'deep-1',
      anchor: 'hello',
      text: 'comment',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
      replies: [
        { id: 'r1', text: 'first reply', author: 'A', timestamp: '2024-01-01T00:00:00.000Z' },
        { id: 'r2', text: 'second reply', author: 'B', timestamp: '2024-01-02T00:00:00.000Z' },
        { id: 'r3', text: 'third reply', author: 'C', timestamp: '2024-01-03T00:00:00.000Z' },
      ],
    };
    const raw = `${serializeComment(comment)}hello world`;
    const parsed = parseComments(raw);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].replies).toHaveLength(3);
  });
});

describe('updateCommentAnchor and cleanOffset after backward drag', () => {
  it('marker stays in place after anchor expansion — cleanOffset unchanged', () => {
    const raw =
      'Some text before ' +
      `${marker({ id: 'drag-1', anchor: 'target' })}target end.`;

    const expanded = updateCommentAnchor(raw, 'drag-1', 'text before target');
    const parsed = parseComments(expanded);
    const comment = parsed.comments[0];
    const clean = parsed.cleanMarkdown;

    // Marker hasn't moved, so cleanOffset stays at the marker's position
    expect(comment.cleanOffset).toBe('Some text before '.length);
    // But the new anchor starts BEFORE cleanOffset
    expect(comment.anchor).toBe('text before target');
    expect(clean.indexOf(comment.anchor)).toBeLessThan(comment.cleanOffset!);
  });

  it('cleanOffset gap grows with formatting characters between anchor start and marker', () => {
    // In rendered HTML, formatting markers (**, *, ##) are stripped, so the
    // rendered-text position of "target" is closer to the start than
    // cleanOffset suggests. When the anchor expands backwards, the gap
    // between cleanOffset and the anchor's rendered position grows further.
    const raw =
      '## Heading\n\n' +
      'Has **bold** and *italic* and **more bold** ' +
      `${marker({ id: 'gap-1', anchor: 'target' })}target end.`;

    const parsed = parseComments(raw);
    const comment = parsed.comments[0];
    const clean = parsed.cleanMarkdown;

    // cleanOffset includes ## \n\n ** ** * * ** ** characters
    const targetInClean = clean.indexOf('target');
    // cleanOffset == targetInClean because marker is right before "target"
    expect(comment.cleanOffset).toBe(targetInClean);

    // In rendered text (no ##, **, *), "target" would be at a LOWER position.
    // The formatting chars add ~20+ chars of offset. wrapText must account
    // for this when searching, especially after anchor expansion.
    const formattingChars = clean.slice(0, targetInClean).replace(/[^#*_\n]/g, '').length;
    expect(formattingChars).toBeGreaterThan(10);
  });
});

describe('stripInlineFormatting via insertComment', () => {
  it('finds anchor inside strikethrough formatting', () => {
    const raw = 'This has ~~deleted~~ text';
    const result = insertComment(raw, 'deleted', 'why struck?');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].anchor).toBe('deleted');
  });

  it('finds anchor with multiple formatting markers', () => {
    const raw = 'This is **_really_ important** stuff';
    const result = insertComment(raw, 'really important', 'noted');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('finds anchor in deeply nested list', () => {
    const raw = '1. first\n2. second\n3. third';
    const result = insertComment(raw, 'second', 'check');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });

  it('preserves literal asterisks flanked by spaces', () => {
    const raw = 'Use a * as wildcard here';
    const result = insertComment(raw, 'a * as', 'clarify');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
  });
});

describe('stripInlineFormatting with fenced code blocks', () => {
  it('strips fence markers but keeps code block content', () => {
    const md = '```\nhello\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('hello');
    expect(plain).not.toContain('```');
  });

  it('strips info string along with opening fence', () => {
    const md = '```mermaid\ngraph TD\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('graph TD');
    expect(plain).not.toContain('mermaid');
  });

  it('preserves backticks inside code blocks as literal text', () => {
    const md = '```\nuse `backticks` here\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('`backticks`');
  });

  it('preserves asterisks inside code blocks as literal text', () => {
    const md = '```\n**not bold** and *not italic*\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('**not bold**');
    expect(plain).toContain('*not italic*');
  });

  it('handles tilde-fenced code blocks', () => {
    const md = '~~~\ncode here\n~~~';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('code here');
    expect(plain).not.toContain('~~~');
  });

  it('handles text before and after code blocks', () => {
    const md = 'before\n\n```\ncode\n```\n\nafter';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('before');
    expect(plain).toContain('code');
    expect(plain).toContain('after');
    expect(plain).not.toContain('```');
  });

  it('maps code block content offsets back to correct clean-markdown positions', () => {
    const md = 'abc\n```\nxyz\n```\ndef';
    const { plain, toCleanOffset } = stripInlineFormatting(md);
    const xyzInPlain = plain.indexOf('xyz');
    expect(xyzInPlain).toBeGreaterThan(-1);
    const cleanOff = toCleanOffset(xyzInPlain);
    expect(md.slice(cleanOff, cleanOff + 3)).toBe('xyz');
  });

  it('handles multiple code blocks', () => {
    const md = '```\nfirst\n```\n\n```\nsecond\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('first');
    expect(plain).toContain('second');
    expect(plain).not.toContain('```');
  });

  it('requires closing fence to match opening fence character', () => {
    // Backtick open should not be closed by tilde
    const md = '```\ncontent\n~~~\nmore\n```';
    const { plain } = stripInlineFormatting(md);
    // ~~~ inside backtick block is content, not a closing fence
    expect(plain).toContain('~~~');
    expect(plain).toContain('content');
    expect(plain).toContain('more');
  });

  it('requires closing fence length >= opening fence length', () => {
    const md = '````\nshort ``` not closing\n````';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('short ``` not closing');
  });

  it('still strips inline backticks outside code blocks', () => {
    const md = 'Use `code` here';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('Use code here');
  });

  it('handles code block at end of file without trailing newline', () => {
    const md = '```\ncode\n```';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toContain('code');
    expect(plain).not.toContain('```');
  });
});

describe('insertComment inside fenced code blocks', () => {
  it('places marker before a mermaid code block, not inside it', () => {
    const raw = '# Diagram\n\n```mermaid\ngraph TD\n    A --> B\n```\n\nEnd.';
    const result = insertComment(raw, 'graph TD', 'fix diagram');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].anchor).toBe('graph TD');
    // The marker must NOT appear inside the code block (would be literal text)
    const codeBlockMatch = result.match(/```mermaid\n[\s\S]*?```/);
    expect(codeBlockMatch).toBeTruthy();
    expect(codeBlockMatch![0]).not.toContain('@comment');
  });

  it('places marker before a generic fenced code block', () => {
    const raw = 'Text before\n\n```js\nconst x = 1;\n```\n\nText after';
    const result = insertComment(raw, 'const x = 1;', 'refactor');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const codeBlockMatch = result.match(/```js\n[\s\S]*?```/);
    expect(codeBlockMatch).toBeTruthy();
    expect(codeBlockMatch![0]).not.toContain('@comment');
  });

  it('places marker before a tilde-fenced code block', () => {
    const raw = 'Before\n\n~~~\nsome code\n~~~\n\nAfter';
    const result = insertComment(raw, 'some code', 'review');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const codeBlockMatch = result.match(/~~~\n[\s\S]*?~~~/);
    expect(codeBlockMatch).toBeTruthy();
    expect(codeBlockMatch![0]).not.toContain('@comment');
  });

  it('places marker on its own line so the code fence stays at column 0', () => {
    const raw = '# Diagram\n\n```mermaid\ngraph TD\n    A[Start] --> B\n```\n\nEnd.';
    const result = insertComment(raw, 'graph TD', 'fix diagram');
    // The fence must still start at column 0 — the marker gets its own line
    expect(result).toMatch(/\n```mermaid\n/);
    // Marker should NOT be on the same line as the fence
    expect(result).not.toMatch(/@comment.*```mermaid/);
  });

  it('marker before fence preserves valid markdown for other renderers', () => {
    const raw = 'Intro\n\n```mermaid\ngraph TD\n    A[Start] --> B\n```\n\nEnd.';
    const result = insertComment(raw, 'A[Start]', 'rename node');
    // Every opening fence in the result should be at column 0
    for (const line of result.split('\n')) {
      if (line.includes('```') && !line.startsWith('<!--')) {
        expect(line).toMatch(/^`{3}/);
      }
    }
  });

  it('round-trips through insert+parse for tilde-fenced code blocks', () => {
    const raw = 'Before\n\n~~~python\nprint("hi")\n~~~\n\nAfter';
    const result = insertComment(raw, 'print("hi")', 'log instead');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('round-trips through insert+parse for mermaid blocks', () => {
    const raw = 'Title\n\n```mermaid\nsequenceDiagram\n    A->>B: Hello\n```\n\nDone.';
    const result = insertComment(raw, 'A->>B: Hello', 'wrong direction');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('multiple comments on different code blocks all round-trip', () => {
    const raw = '```js\nfoo()\n```\n\nText\n\n```py\nbar()\n```';
    let result = insertComment(raw, 'foo()', 'remove this');
    result = insertComment(result, 'bar()', 'rename');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('does not consume trailing newline for inline markers (not before a fence)', () => {
    const raw = 'Hello world\nSecond line';
    const result = insertComment(raw, 'Hello world', 'rewrite');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // The marker is inline (not on its own line before a fence), so no extra newline handling
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('code block at the very start of the document round-trips', () => {
    const raw = '```js\nconst x = 1;\n```\n\nEnd.';
    const result = insertComment(raw, 'const x = 1;', 'use let');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('still handles inline backticks correctly', () => {
    const raw = 'Use `foo` for this';
    const result = insertComment(raw, 'foo', 'rename');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].anchor).toBe('foo');
  });

  it('comment on code block round-trips through parse', () => {
    const raw = 'Intro\n\n```python\ndef hello():\n    pass\n```\n\nOutro';
    const result = insertComment(raw, 'def hello():', 'add docstring');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // Clean markdown should restore original content
    expect(parsed.cleanMarkdown).toBe(raw);
  });

  it('does not break fence syntax when placing marker before code block', () => {
    const raw = 'Text before\n\n```mermaid\ngraph TD\n    A --> B\n```\n\nText after';
    const result = insertComment(raw, 'graph TD', 'fix diagram');
    // The fence must remain at line start — the marker must NOT be on the same line as ```
    const lines = result.split('\n');
    const fenceLine = lines.find(l => l.startsWith('```mermaid'));
    expect(fenceLine).toBe('```mermaid');
    // Marker should be on a separate line
    const markerLine = lines.find(l => l.includes('@comment'));
    expect(markerLine).toBeTruthy();
    expect(markerLine).not.toContain('```');
  });

  it('preserves fence syntax with tilde code blocks', () => {
    const raw = 'Before\n\n~~~\nsome code\n~~~\n\nAfter';
    const result = insertComment(raw, 'some code', 'review');
    const lines = result.split('\n');
    const fenceLine = lines.find(l => l.startsWith('~~~'));
    expect(fenceLine).toBe('~~~');
  });

  it('preserves fence when code block is at document start', () => {
    const raw = '```js\nconst x = 1;\n```\n\nEnd.';
    const result = insertComment(raw, 'const x = 1;', 'refactor');
    // Fence must be at line start (possibly after a marker line)
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // The code block should still render correctly
    const fenceMatch = result.match(/^```js$/m);
    expect(fenceMatch).toBeTruthy();
  });

  it('preserves fence when adding second comment on duplicate text inside code block', () => {
    // Simulates the user's scenario: "user account" appears both outside and
    // inside a mermaid code block. First comment is on the outside occurrence,
    // second comment targets the code block occurrence.
    const outsideText = 'System creates user account and assigns the User Type.';
    const mermaidBlock = '```mermaid\ngraph TD\n    A[creates user account] --> B\n```';
    const raw = `${outsideText}\n\n${mermaidBlock}\n\nEnd.`;

    // First comment on the outside "user account"
    let result = insertComment(raw, 'user account', 'first comment');
    // Second comment targeting code block "user account"
    const { plain } = stripInlineFormatting(parseComments(result).cleanMarkdown);
    const secondOcc = plain.indexOf('user account', plain.indexOf('user account') + 1);
    result = insertComment(result, 'user account', 'second comment', 'User', undefined, undefined, secondOcc);

    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(2);
    // The mermaid fence must still be at line start
    const fenceMatch = result.match(/^```mermaid$/m);
    expect(fenceMatch).toBeTruthy();
    // Neither marker should be inside the code block
    const codeBlockMatch = result.match(/```mermaid\n[\s\S]*?```/);
    expect(codeBlockMatch).toBeTruthy();
    expect(codeBlockMatch![0]).not.toContain('@comment');
  });

  it('handles anchor that appears both in and outside a code block with hintOffset', () => {
    const raw = 'hello world\n\n```\nhello world\n```';
    // hintOffset pointing to the code block occurrence (past the first "hello world")
    const { plain } = stripInlineFormatting(parseComments(raw).cleanMarkdown);
    const secondOccurrence = plain.indexOf('hello world', plain.indexOf('hello world') + 1);
    const result = insertComment(raw, 'hello world', 'inside code', 'User', undefined, undefined, secondOccurrence);
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // Marker should be placed before the code block, not inside it
    const codeBlockMatch = result.match(/```\n[\s\S]*?```/);
    expect(codeBlockMatch![0]).not.toContain('@comment');
  });

  it('does not interfere with comments on text outside code blocks', () => {
    const raw = 'Normal text\n\n```\ncode\n```\n\nMore text';
    const result = insertComment(raw, 'Normal text', 'edit this');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // Marker should be before "Normal text", not near the code block
    expect(result.indexOf('@comment')).toBeLessThan(result.indexOf('Normal text'));
  });

  it('handles multiple code blocks in the same document', () => {
    const raw = '```\nfirst\n```\n\nMiddle\n\n```\nsecond\n```';
    const result = insertComment(raw, 'second', 'check this');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // Marker should be before the second code block
    const markerIdx = result.indexOf('@comment');
    const secondFenceIdx = result.indexOf('```', result.indexOf('```\n\nMiddle') + 1);
    expect(markerIdx).toBeLessThanOrEqual(secondFenceIdx);
    // First code block should be untouched
    expect(result.slice(0, result.indexOf('\n\nMiddle'))).not.toContain('@comment');
  });
});

describe('comment text containing -->', () => {
  it('round-trips comment text with --> without breaking the marker', () => {
    const raw = 'Some text here';
    const result = insertComment(raw, 'text', 'Use <!-- summary{} --> for this');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].text).toBe('Use <!-- summary{} --> for this');
    expect(parsed.cleanMarkdown).toBe('Some text here');
  });

  it('handles multiple --> occurrences in comment text', () => {
    const raw = 'Hello world';
    const result = insertComment(raw, 'world', 'a --> b --> c');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].text).toBe('a --> b --> c');
  });

  it('handles --> in anchor text', () => {
    const raw = 'Use --> to indicate flow';
    const result = insertComment(raw, '--> to indicate', 'clarify arrow');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].anchor).toBe('--> to indicate');
  });

  it('handles } --> pattern that could trick the regex', () => {
    const raw = 'Some text here';
    const result = insertComment(raw, 'text', 'see <!-- @comment{fake} --> above');
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].text).toBe('see <!-- @comment{fake} --> above');
    expect(parsed.cleanMarkdown).toBe('Some text here');
  });

  it('serializes --> as unicode escape in the marker', () => {
    const comment: MdComment = {
      id: 'test',
      anchor: 'text',
      text: 'has --> in it',
      author: 'User',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const serialized = serializeComment(comment);
    expect(serialized).not.toContain('"has -->');
    expect(serialized).toContain('--\\u003e');
  });
});

describe('pickBestOccurrence', () => {
  it('returns the only occurrence when there is just one', () => {
    expect(pickBestOccurrence('hello world', [6], 'world', 6)).toBe(6);
  });

  it('falls back to nearest hintOffset when no context is provided', () => {
    // "foo" at 0, 8, 16; hintOffset=15 → pick 16
    expect(pickBestOccurrence('foo bar foo bar foo', [0, 8, 16], 'foo', 15)).toBe(16);
  });

  it('uses context to pick correct occurrence even when hintOffset is wrong', () => {
    const plain = 'alpha foo beta gamma foo delta';
    // "foo" at 6 and 21. Suppose hintOffset is wrong (say 5, closer to 1st "foo")
    // but context uniquely identifies the 2nd "foo"
    const result = pickBestOccurrence(
      plain, [6, 21], 'foo', 5,
      'gamma ', ' delta',
    );
    expect(result).toBe(21);
  });

  it('uses context to pick correct occurrence with many duplicates', () => {
    const plain = 'x foo y foo z foo w';
    // "foo" at 2, 8, 14. Context identifies 2nd one.
    const result = pickBestOccurrence(
      plain, [2, 8, 14], 'foo', 0,
      'y ', ' z',
    );
    expect(result).toBe(8);
  });

  it('handles whitespace-normalized context matching (blank line drift)', () => {
    // Plain text has \n\n between paragraphs (markdown), DOM has \n (rendered HTML).
    // The whitespace normalization in pickBestOccurrence should handle this drift.
    const plain = 'alpha foo beta\n\ngamma\n\ndelta foo epsilon';
    // "foo" at positions 6 and 29
    // In DOM text, 2nd "foo" would be preceded by "delta " (same after normalization)
    const result = pickBestOccurrence(
      plain, [6, 29], 'foo', 5, // hintOffset=5 is closer to 1st foo
      'delta ',    // contextBefore from DOM (uniquely identifies 2nd occurrence)
      ' epsilon',  // contextAfter
    );
    // Should pick 2nd "foo" despite wrong hintOffset, thanks to context matching
    expect(result).toBe(29);
  });

  it('uses hintOffset as tiebreaker when context scores are equal', () => {
    // Identical surrounding context — context can't disambiguate
    const plain = 'x foo y x foo y';
    const result = pickBestOccurrence(
      plain, [2, 10], 'foo', 9,
      'x ', ' y',
    );
    // Both have identical context ("x " before, " y" after), so hintOffset breaks tie
    expect(result).toBe(10);
  });

  it('handles empty context strings gracefully', () => {
    const plain = 'foo bar foo';
    const result = pickBestOccurrence(plain, [0, 8], 'foo', 7, '', '');
    // Empty context → fall back to hintOffset
    expect(result).toBe(8);
  });
});

describe('context-based disambiguation in insertComment', () => {
  it('uses context to pick correct duplicate when hintOffset has drift', () => {
    // Document with a link that causes offset drift between DOM and plain text.
    // "foo" appears twice. The link adds chars to plain text that aren't in DOM text.
    const raw = 'See [details](https://example.com/long-url) for foo info.\n\nAnother foo here.';
    // In DOM text: "See details for foo info.\n\nAnother foo here." (no link syntax)
    // hintOffset from DOM for 2nd "foo" ≈ 35 (in DOM text)
    // But in plain text (with link stripping), 2nd "foo" is also around 35
    // Without link stripping, 2nd "foo" would be at ~65 (much further from hintOffset=35)
    // Context uniquely identifies the 2nd "foo" regardless
    const result = insertComment(
      raw, 'foo', 'check this', 'User',
      'Another ', // contextBefore (from DOM, last few chars before 2nd "foo")
      ' here.',   // contextAfter
      35,         // hintOffset in DOM space (may not match plain space exactly)
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // The marker should be before the SECOND "foo" (in "Another foo here")
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toContain('Another ');
    expect(textBefore).not.toContain('<!-- @comment');
  });

  it('uses context to pick correct duplicate across multiple paragraphs', () => {
    const raw = 'First paragraph with target word.\n\nSecond paragraph.\n\nThird paragraph with target word.';
    // User selected "target" in the third paragraph
    const result = insertComment(
      raw, 'target', 'fix', 'User',
      'with ',     // contextBefore
      ' word.',    // contextAfter
      70,          // hintOffset (approximate, may have drift)
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    // Both "target" have "with " before and " word." after — identical local context!
    // So hintOffset breaks the tie. With hintOffset=70 (closer to 2nd occurrence):
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toContain('Third paragraph with ');
  });

  it('context disambiguates when surrounding text differs', () => {
    // "the cat" appears at offsets 0 (as "The cat") and 38 (as "the cat")
    // But the clean text search is case-sensitive, so "the cat" only matches at 38
    // Let's use a proper duplicate:
    const raw2 = 'the cat sat on the mat.\nthe dog saw the cat run.';
    const result = insertComment(
      raw2, 'the cat', 'which one', 'User',
      'saw ',       // contextBefore: chars before 2nd "the cat"
      ' run.',      // contextAfter
      39,
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('the cat sat on the mat.\nthe dog saw ');
  });

  it('still works when only contextBefore is available', () => {
    const raw = 'start foo end\nstart foo end';
    const result = insertComment(
      raw, 'foo', 'note', 'User',
      '\nstart ', // contextBefore identifies 2nd occurrence (has newline prefix)
      undefined,
      15,
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('start foo end\nstart ');
  });

  it('still works when only contextAfter is available', () => {
    const raw = 'foo alpha\nfoo beta';
    const result = insertComment(
      raw, 'foo', 'note', 'User',
      undefined,
      ' beta', // contextAfter identifies 2nd occurrence
      10,
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toBe('foo alpha\n');
  });
});

describe('stripInlineFormatting with links and images', () => {
  it('strips link syntax, keeping only text', () => {
    const md = 'See [click here](https://example.com) for details';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('See click here for details');
    expect(plain).not.toContain('[');
    expect(plain).not.toContain('](');
    expect(plain).not.toContain('example.com');
  });

  it('strips image syntax entirely', () => {
    const md = 'Before ![alt text](image.png) after';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('Before  after');
    expect(plain).not.toContain('alt text');
    expect(plain).not.toContain('image.png');
  });

  it('handles multiple links', () => {
    const md = '[a](u1) and [b](u2) and [c](u3)';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('a and b and c');
  });

  it('handles link with formatting inside', () => {
    const md = 'See [**bold link**](url) here';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('See bold link here');
  });

  it('maps link text offsets back correctly', () => {
    const md = 'before [link text](url) after';
    const { plain, toCleanOffset } = stripInlineFormatting(md);
    const linkIdx = plain.indexOf('link text');
    expect(linkIdx).toBeGreaterThan(-1);
    // "link text" in clean markdown is at position 8 (after "before [")
    const cleanOff = toCleanOffset(linkIdx);
    expect(md.slice(cleanOff, cleanOff + 9)).toBe('link text');
  });

  it('maps offsets correctly after image removal', () => {
    const md = 'before ![img](url) after';
    const { plain, toCleanOffset } = stripInlineFormatting(md);
    const afterIdx = plain.indexOf('after');
    expect(afterIdx).toBeGreaterThan(-1);
    const cleanOff = toCleanOffset(afterIdx);
    expect(md.slice(cleanOff, cleanOff + 5)).toBe('after');
  });

  it('does not strip brackets that are not links', () => {
    const md = 'array[0] is valid';
    const { plain } = stripInlineFormatting(md);
    // [0] is not followed by (...), so it stays as-is
    expect(plain).toBe('array[0] is valid');
  });

  it('handles link at start of document', () => {
    const md = '[first](url) rest';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('first rest');
  });

  it('handles link at end of document', () => {
    const md = 'start [last](url)';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('start last');
  });

  it('handles image next to link', () => {
    const md = '![img](pic.png)[link](url)';
    const { plain } = stripInlineFormatting(md);
    expect(plain).toBe('link');
  });

  it('preserves links inside fenced code blocks', () => {
    const md = '```\n[not a link](url)\n```';
    const { plain } = stripInlineFormatting(md);
    // Inside code blocks, content is preserved as-is
    expect(plain).toContain('[not a link](url)');
  });

  it('toPlainOffset handles link-adjusted positions', () => {
    const md = 'aa [link](url) bb';
    const { toPlainOffset } = stripInlineFormatting(md);
    // "bb" is at clean offset 15 (after "aa [link](url) ")
    // In plain text, it's at offset 8 (after "aa link " = 8 chars)
    const plainOff = toPlainOffset(15);
    expect(plainOff).toBe(8);
  });
});

describe('insertComment with links causing offset drift', () => {
  it('places marker correctly when links shift offsets', () => {
    // Without link stripping, "foo" positions in plain text would be wrong
    // because [text](url) keeps the full syntax. With link stripping,
    // the plain text more closely matches DOM textContent.
    const raw = '[intro](url1) has foo. Then [outro](url2) has foo too.';
    // In DOM text: "intro has foo. Then outro has foo too."
    // User selects 2nd "foo" — hintOffset in DOM is ~33
    const result = insertComment(
      raw, 'foo', 'second', 'User',
      'has ', // contextBefore
      ' too.', // contextAfter
      33,
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    expect(textBefore).toContain('has ');
    expect(textBefore).toContain('[outro]');
  });

  it('handles document with many links and duplicate text', () => {
    const raw = [
      '# [Project](url1) Overview',
      '',
      'The [system](url2) has a key component.',
      '',
      '## [Details](url3) Section',
      '',
      'The [framework](url4) has a key component.',
    ].join('\n');
    // "key" appears twice. User selects 2nd one.
    // Context: "has a " before, " component" after
    const result = insertComment(
      raw, 'key', 'review', 'User',
      'has a ',
      ' component.',
      80, // approximate DOM offset
    );
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    const markerIdx = result.indexOf('<!-- @comment');
    const textBefore = result.slice(0, markerIdx);
    // Should be in the second paragraph (after "Details Section")
    expect(textBefore).toContain('[framework]');
  });
});
