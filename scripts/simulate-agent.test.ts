import { describe, it, expect } from 'vitest';
import {
  applySimulation,
  editNearAnchor,
  indexOfOutsideMarkers,
  makeReply,
} from './simulate-agent';
import { parseComments } from '../src/lib/comment-parser';

const SAMPLE = `# Spec

Plain body.

<!-- @comment{"id":"c1","text":"clarify","author":"D","timestamp":"2026-01-01T00:00:00.000Z","anchor":"Plain body."} -->
Plain body.

More body.
`;

describe('indexOfOutsideMarkers', () => {
  it('returns -1 when the needle is absent', () => {
    expect(indexOfOutsideMarkers('hello world', 'foo')).toBe(-1);
  });

  it('returns the body offset and skips matches inside @comment markers', () => {
    // The literal "Plain body." appears twice — inside the marker JSON and
    // again as the body line. We want the body line.
    const idx = indexOfOutsideMarkers(SAMPLE, 'Plain body.');
    expect(idx).toBeGreaterThan(0);
    // The first non-marker hit should be the standalone body line above the
    // marker (line 3), not inside the JSON.
    const before = SAMPLE.slice(0, idx);
    expect(before).not.toContain('<!-- @comment');
  });

  it('finds occurrences after a marker too', () => {
    const haystack = '<!-- @comment{"id":"a","anchor":"foo"} -->\nfoo bar\n';
    const idx = indexOfOutsideMarkers(haystack, 'foo');
    // Should land on the body line, not inside the JSON.
    expect(haystack.slice(idx, idx + 7)).toBe('foo bar');
  });
});

describe('editNearAnchor', () => {
  it('appends "[Updated by Agent]" after the body anchor only', () => {
    const out = editNearAnchor(SAMPLE, 'Plain body.');
    // The body line gains the tag.
    expect(out).toContain('Plain body. [Updated by Agent]');
    // The marker JSON is untouched.
    expect(out).toContain('"anchor":"Plain body."');
    expect(out).not.toContain('"anchor":"Plain body. [Updated by Agent]"');
  });

  it('returns the input unchanged when the anchor is missing', () => {
    expect(editNearAnchor(SAMPLE, 'nonexistent anchor')).toBe(SAMPLE);
  });

  it('returns the input unchanged for an empty anchor', () => {
    expect(editNearAnchor(SAMPLE, '')).toBe(SAMPLE);
  });
});

describe('makeReply', () => {
  it('rotates through the canned replies', () => {
    const a = makeReply('first', 0);
    const b = makeReply('second', 1);
    expect(a).not.toBe(b);
  });

  it('embeds the original comment text in the first variant', () => {
    expect(makeReply('Specific concern.', 0)).toContain('Specific concern.');
  });
});

describe('applySimulation', () => {
  const opts = {
    edit: true,
    reply: true,
    resolve: true,
    author: 'TestAgent',
    dryRun: false,
  };

  it('edits content, adds a reply, and resolves the open comment', () => {
    const out = applySimulation(SAMPLE, opts);
    expect(out).toContain('Plain body. [Updated by Agent]');
    const { comments } = parseComments(out);
    expect(comments).toHaveLength(1);
    const c = comments[0];
    expect(c.replies?.[0]?.author).toBe('TestAgent');
    expect(c.resolved).toBe(true);
  });

  it('skips already-resolved comments', () => {
    const resolved = SAMPLE.replace('"anchor":"Plain body."', '"anchor":"Plain body.","resolved":true');
    const out = applySimulation(resolved, opts);
    // Body should not have been edited because no open comments remained.
    expect(out).not.toContain('[Updated by Agent]');
    expect(out).toBe(resolved);
  });

  it('--reply-only leaves content unchanged but adds a reply', () => {
    const out = applySimulation(SAMPLE, {
      ...opts,
      edit: false,
      resolve: false,
    });
    expect(out).not.toContain('[Updated by Agent]');
    const { comments } = parseComments(out);
    expect(comments[0].replies?.length).toBe(1);
    expect(comments[0].resolved).toBeFalsy();
  });

  it('--edit-only changes content without touching comment metadata', () => {
    const out = applySimulation(SAMPLE, {
      ...opts,
      reply: false,
      resolve: false,
    });
    expect(out).toContain('[Updated by Agent]');
    const { comments } = parseComments(out);
    expect(comments[0].replies ?? []).toEqual([]);
    expect(comments[0].resolved).toBeFalsy();
  });
});
