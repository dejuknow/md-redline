import { describe, it, expect } from 'vitest';
import { computeDiff } from '../lib/diff';
import {
  segmentDiff,
  segmentDiffFenceAware,
  countChunks,
  findFenceRanges,
} from './RenderedDiffView';

describe('segmentDiff', () => {
  it('returns a single same segment for identical text', () => {
    const diff = computeDiff('a\nb\nc', 'a\nb\nc');
    const segs = segmentDiff(diff);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('same');
    expect(segs[0].text).toBe('a\nb\nc');
    expect(countChunks(segs)).toBe(0);
  });

  it('groups contiguous added lines into one segment', () => {
    const diff = computeDiff('a\nb', 'a\nb\nc\nd');
    const segs = segmentDiff(diff);
    // Expect: [same:"a\nb", added:"c\nd"]
    expect(segs.map((s) => s.type)).toEqual(['same', 'added']);
    expect(segs[1].text).toBe('c\nd');
    expect(countChunks(segs)).toBe(1);
  });

  it('groups contiguous removed lines into one segment', () => {
    const diff = computeDiff('a\nb\nc\nd', 'a\nb');
    const segs = segmentDiff(diff);
    expect(segs.map((s) => s.type)).toEqual(['same', 'removed']);
    expect(segs[1].text).toBe('c\nd');
    expect(countChunks(segs)).toBe(1);
  });

  it('keeps removed and added as separate adjacent segments', () => {
    // Replace "b" with "B"
    const diff = computeDiff('a\nb\nc', 'a\nB\nc');
    const segs = segmentDiff(diff);
    expect(segs.map((s) => s.type)).toEqual(['same', 'removed', 'added', 'same']);
    expect(segs[1].text).toBe('b');
    expect(segs[2].text).toBe('B');
  });

  it('assigns the same chunk index to adjacent removed+added pairs', () => {
    const diff = computeDiff('a\nb\nc', 'a\nB\nc');
    const segs = segmentDiff(diff);
    const removed = segs.find((s) => s.type === 'removed')!;
    const added = segs.find((s) => s.type === 'added')!;
    expect(removed.chunkIndex).toBe(added.chunkIndex);
    expect(countChunks(segs)).toBe(1);
  });

  it('counts multiple separated changes as distinct chunks', () => {
    // Two unrelated edits
    const diff = computeDiff('a\nb\nc\nd\ne', 'A\nb\nc\nD\ne');
    const segs = segmentDiff(diff);
    expect(countChunks(segs)).toBe(2);
  });

  it('handles a fully replaced file as a single chunk', () => {
    const diff = computeDiff('a\nb\nc', 'x\ny\nz');
    const segs = segmentDiff(diff);
    // removed segment + added segment, both chunk 0
    const changeSegs = segs.filter((s) => s.type !== 'same');
    expect(changeSegs.every((s) => s.chunkIndex === 0)).toBe(true);
    expect(countChunks(segs)).toBe(1);
  });
});

describe('findFenceRanges', () => {
  it('returns empty for text with no fences', () => {
    expect(findFenceRanges('# Heading\n\nplain text')).toEqual([]);
  });

  it('finds a single backtick fence', () => {
    const text = '# Title\n\n```js\nconst x = 1;\n```\n\nafter';
    expect(findFenceRanges(text)).toEqual([{ start: 3, end: 5 }]);
  });

  it('finds multiple fences', () => {
    const text = '```\nA\n```\n\nbody\n\n~~~\nB\n~~~';
    const ranges = findFenceRanges(text);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ start: 1, end: 3 });
    expect(ranges[1]).toEqual({ start: 7, end: 9 });
  });

  it('treats an unclosed fence as extending to EOF', () => {
    const text = '# Title\n\n```js\nconst x = 1;\nconst y = 2;';
    const ranges = findFenceRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(3);
    expect(ranges[0].end).toBe(5);
  });

  it('does not match an opening backtick fence with a tilde fence (different chars)', () => {
    const text = '```\nbody\n~~~';
    const ranges = findFenceRanges(text);
    // Unclosed backtick fence — extends to EOF
    expect(ranges).toEqual([{ start: 1, end: 3 }]);
  });
});

describe('segmentDiffFenceAware', () => {
  it('falls through to segmentDiff when neither side has fences', () => {
    const old = 'a\nb\nc';
    const next = 'a\nB\nc';
    const fenceAware = segmentDiffFenceAware(computeDiff(old, next), old, next);
    const plain = segmentDiff(computeDiff(old, next));
    expect(fenceAware).toEqual(plain);
  });

  it('renders an unchanged fence as a single same segment', () => {
    const fence = '```js\nconst x = 1;\n```';
    const old = `intro\n\n${fence}\n\nafter`;
    const next = `intro updated\n\n${fence}\n\nafter`;
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    // The fence text should appear as one same segment, not multiple chunks.
    const fenceSeg = segs.find((s) => s.text === fence);
    expect(fenceSeg).toBeDefined();
    expect(fenceSeg!.type).toBe('same');
  });

  it('renders a one-line edit inside a fence as full removed+added fences', () => {
    // The bug: per-line segmenting splits the fence into broken pieces.
    // The fix: emit the entire old and new fences as single segments.
    const old = '```js\nconst x = 1;\n```';
    const next = '```js\nconst x = 2;\n```';
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    const removed = segs.find((s) => s.type === 'removed');
    const added = segs.find((s) => s.type === 'added');
    expect(removed?.text).toBe('```js\nconst x = 1;\n```');
    expect(added?.text).toBe('```js\nconst x = 2;\n```');
    // Both halves of the change share the same chunk index.
    expect(removed?.chunkIndex).toBe(added?.chunkIndex);
    expect(countChunks(segs)).toBe(1);
  });

  it('renders a body change in a multi-line fence as one removed/added pair', () => {
    const old = '```js\nlet x = 1;\nlet y = 2;\nlet z = 3;\n```';
    const next = '```js\nlet x = 1;\nlet y = 2000;\nlet z = 3;\n```';
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    const removed = segs.find((s) => s.type === 'removed');
    const added = segs.find((s) => s.type === 'added');
    expect(removed?.text).toBe(old);
    expect(added?.text).toBe(next);
    expect(countChunks(segs)).toBe(1);
  });

  it('preserves prose context around a fence change', () => {
    const old = 'before\n\n```\nA\n```\n\nafter';
    const next = 'before\n\n```\nB\n```\n\nafter';
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    // First segment is the same prose before, last is the same prose after.
    expect(segs[0].type).toBe('same');
    expect(segs[0].text).toContain('before');
    expect(segs[segs.length - 1].type).toBe('same');
    expect(segs[segs.length - 1].text).toContain('after');
    // Middle has the removed and added fences.
    const removed = segs.find((s) => s.type === 'removed');
    const added = segs.find((s) => s.type === 'added');
    expect(removed?.text).toBe('```\nA\n```');
    expect(added?.text).toBe('```\nB\n```');
  });

  it('handles a fence added in new (not present in old)', () => {
    const old = 'paragraph\n';
    const next = 'paragraph\n\n```\nnew block\n```\n';
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    // The fence is emitted as a single atomic segment containing the
    // full ```...``` block. Other added segments may exist for the blank
    // line introduced before the fence.
    const fenceSeg = segs.find(
      (s) => s.type === 'added' && s.text === '```\nnew block\n```',
    );
    expect(fenceSeg).toBeDefined();
    expect(segs.find((s) => s.type === 'removed')).toBeUndefined();
  });

  it('handles a fence removed from new (only in old)', () => {
    const old = 'paragraph\n\n```\ngone block\n```\n';
    const next = 'paragraph\n';
    const segs = segmentDiffFenceAware(computeDiff(old, next), old, next);
    const fenceSeg = segs.find(
      (s) => s.type === 'removed' && s.text === '```\ngone block\n```',
    );
    expect(fenceSeg).toBeDefined();
    expect(segs.find((s) => s.type === 'added')).toBeUndefined();
  });
});
