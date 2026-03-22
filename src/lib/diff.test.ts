import { describe, it, expect } from 'vitest';
import { computeDiff } from './diff';

describe('computeDiff', () => {
  it('returns all same lines for identical inputs', () => {
    const text = 'line 1\nline 2\nline 3';
    const diff = computeDiff(text, text);
    expect(diff.every((l) => l.type === 'same')).toBe(true);
    expect(diff).toHaveLength(3);
  });

  it('returns empty array for two empty strings', () => {
    const diff = computeDiff('', '');
    // Empty string splits to [''], so 1 "same" line
    expect(diff).toHaveLength(1);
    expect(diff[0].type).toBe('same');
    expect(diff[0].text).toBe('');
  });

  it('detects added lines', () => {
    const diff = computeDiff('a\nb', 'a\nb\nc');
    const added = diff.filter((l) => l.type === 'added');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('c');
  });

  it('detects removed lines', () => {
    const diff = computeDiff('a\nb\nc', 'a\nc');
    const removed = diff.filter((l) => l.type === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('b');
  });

  it('handles completely different content', () => {
    const diff = computeDiff('old line 1\nold line 2', 'new line 1\nnew line 2');
    const removed = diff.filter((l) => l.type === 'removed');
    const added = diff.filter((l) => l.type === 'added');
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(2);
  });

  it('handles new content from empty', () => {
    const diff = computeDiff('', 'new line');
    // '' -> [''], 'new line' -> ['new line']
    const removed = diff.filter((l) => l.type === 'removed');
    const added = diff.filter((l) => l.type === 'added');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('new line');
  });

  it('handles removal to empty', () => {
    const diff = computeDiff('old line', '');
    const removed = diff.filter((l) => l.type === 'removed');
    const added = diff.filter((l) => l.type === 'added');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('old line');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('');
  });

  it('preserves line numbers for same lines', () => {
    const diff = computeDiff('a\nb\nc', 'a\nb\nc');
    expect(diff[0]).toMatchObject({ type: 'same', text: 'a', oldLineNo: 1, newLineNo: 1 });
    expect(diff[1]).toMatchObject({ type: 'same', text: 'b', oldLineNo: 2, newLineNo: 2 });
    expect(diff[2]).toMatchObject({ type: 'same', text: 'c', oldLineNo: 3, newLineNo: 3 });
  });

  it('assigns correct line numbers for mixed changes', () => {
    const diff = computeDiff('a\nb\nc', 'a\nx\nc');
    // a = same, b = removed, x = added, c = same
    const removed = diff.find((l) => l.type === 'removed');
    const added = diff.find((l) => l.type === 'added');
    expect(removed?.oldLineNo).toBe(2);
    expect(added?.newLineNo).toBe(2);
  });

  it('handles multi-line insertions in the middle', () => {
    const diff = computeDiff('a\nc', 'a\nb1\nb2\nc');
    const added = diff.filter((l) => l.type === 'added');
    expect(added).toHaveLength(2);
    expect(added[0].text).toBe('b1');
    expect(added[1].text).toBe('b2');
  });

  it('handles multi-line removals in the middle', () => {
    const diff = computeDiff('a\nb1\nb2\nc', 'a\nc');
    const removed = diff.filter((l) => l.type === 'removed');
    expect(removed).toHaveLength(2);
    expect(removed[0].text).toBe('b1');
    expect(removed[1].text).toBe('b2');
  });

  it('produces correct output order: removed then added for replacements', () => {
    const diff = computeDiff('a\nold\nc', 'a\nnew\nc');
    const changeIdx = diff.findIndex((l) => l.type !== 'same');
    // The removed line should come before the added line
    expect(diff[changeIdx].type).toBe('removed');
    expect(diff[changeIdx].text).toBe('old');
    expect(diff[changeIdx + 1].type).toBe('added');
    expect(diff[changeIdx + 1].text).toBe('new');
  });
});
