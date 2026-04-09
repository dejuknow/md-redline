import { describe, it, expect } from 'vitest';
import { computeDiff } from '../lib/diff';
import { segmentDiff, countChunks } from './RenderedDiffView';

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
