import { describe, it, expect } from 'vitest';
import {
  parseComments,
  insertComment,
  removeComment,
  resolveComment,
  unresolveComment,
  editComment,
  updateCommentAnchor,
  addReply,
  resolveAllComments,
  removeResolvedComments,
  serializeComment,
  detectMissingAnchors,
} from './comment-parser';
import { getEffectiveStatus } from '../types';
import type { MdComment } from '../types';

// Helper to make a comment marker
function marker(overrides: Partial<MdComment> = {}): string {
  const comment: MdComment = {
    id: overrides.id ?? 'test-id',
    anchor: overrides.anchor ?? 'hello',
    text: overrides.text ?? 'my comment',
    author: overrides.author ?? 'User',
    timestamp: overrides.timestamp ?? '2024-01-01T00:00:00.000Z',
    resolved: overrides.resolved ?? false,
    status: overrides.status ?? 'open',
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
      resolved: false,
      status: 'open',
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

describe('resolveComment / unresolveComment', () => {
  it('resolves a comment', () => {
    const raw = `${marker({ id: 'r1', resolved: false, status: 'open' })}hello`;
    const result = resolveComment(raw, 'r1');
    const parsed = parseComments(result);
    expect(parsed.comments[0].resolved).toBe(true);
    expect(parsed.comments[0].status).toBe('resolved');
  });

  it('unresolves a comment', () => {
    const raw = `${marker({ id: 'r1', resolved: true, status: 'resolved' })}hello`;
    const result = unresolveComment(raw, 'r1');
    const parsed = parseComments(result);
    expect(parsed.comments[0].resolved).toBe(false);
    expect(parsed.comments[0].status).toBe('open');
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

describe('resolveAllComments', () => {
  it('resolves all open comments', () => {
    const raw = `${marker({ id: 'a', resolved: false, status: 'open' })}hello ${marker({ id: 'b', resolved: false, status: 'open' })}world`;
    const result = resolveAllComments(raw);
    const parsed = parseComments(result);
    expect(parsed.comments.every((c) => c.resolved)).toBe(true);
    expect(parsed.comments.every((c) => c.status === 'resolved')).toBe(true);
  });

  it('leaves already resolved comments unchanged', () => {
    const raw = `${marker({ id: 'a', resolved: true, status: 'resolved' })}hello`;
    const result = resolveAllComments(raw);
    expect(result).toBe(raw); // no change
  });
});

describe('removeResolvedComments', () => {
  it('removes all resolved comments', () => {
    const raw = `${marker({ id: 'a', resolved: true })}hello ${marker({ id: 'b', resolved: false })}world`;
    const result = removeResolvedComments(raw);
    const parsed = parseComments(result);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].id).toBe('b');
  });

  it('leaves unresolved comments intact', () => {
    const raw = `${marker({ id: 'a', resolved: false })}hello`;
    const result = removeResolvedComments(raw);
    expect(result).toBe(raw);
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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

describe('getEffectiveStatus', () => {
  it('returns explicit status when present', () => {
    expect(getEffectiveStatus({ status: 'resolved' } as MdComment)).toBe('resolved');
    expect(getEffectiveStatus({ status: 'open' } as MdComment)).toBe('open');
  });

  it('maps legacy statuses to simplified ones', () => {
    expect(getEffectiveStatus({ status: 'accepted' } as unknown as MdComment)).toBe('resolved');
  });

  it('falls back to resolved boolean when status is missing (legacy)', () => {
    expect(getEffectiveStatus({ resolved: true } as MdComment)).toBe('resolved');
    expect(getEffectiveStatus({ resolved: false } as MdComment)).toBe('open');
  });

  it('falls back to open when both status and resolved are falsy', () => {
    expect(getEffectiveStatus({} as MdComment)).toBe('open');
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

  it('skips accepted comments', () => {
    const clean = 'Hello world';
    const comments = [
      { id: 'a', anchor: 'deleted text', status: 'accepted', resolved: true },
    ] as MdComment[];
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
      contextBefore: 'context before ',
      contextAfter: ' context after',
    };
    const raw = `context before ${serializeComment(comment)}${filler} context after end.`;
    const parsed = parseComments(raw);
    const clean = parsed.cleanMarkdown;
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
      resolved: false,
      status: 'open',
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
