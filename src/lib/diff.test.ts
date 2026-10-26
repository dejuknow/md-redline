import { describe, it, expect } from 'vitest';
import { computeDiff, myersLineDiff, MAX_EDIT_DISTANCE, type DiffLine } from './diff';

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

  it('handles large files without hanging (prefix/suffix optimization)', () => {
    // Create two 2000-line files with a small change in the middle
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join('\n');
    const newLines = [...lines];
    newLines[1000] = 'CHANGED LINE';
    const newText = newLines.join('\n');

    const start = Date.now();
    const diff = computeDiff(oldText, newText);
    const elapsed = Date.now() - start;

    // Should complete in well under 5 seconds (prefix/suffix optimization)
    expect(elapsed).toBeLessThan(5000);
    // Should detect the change
    const removed = diff.filter((l) => l.type === 'removed');
    const added = diff.filter((l) => l.type === 'added');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('line 1001');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('CHANGED LINE');
  });

  it('handles large files with completely different content', () => {
    const oldLines = Array.from({ length: 1500 }, (_, i) => `old ${i}`);
    const newLines = Array.from({ length: 1500 }, (_, i) => `new ${i}`);

    const start = Date.now();
    const diff = computeDiff(oldLines.join('\n'), newLines.join('\n'));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(diff.filter((l) => l.type === 'removed').length).toBe(1500);
    expect(diff.filter((l) => l.type === 'added').length).toBe(1500);
  });

  it('handles large files with shared prefix/suffix but large different middle', () => {
    // Common prefix + 1200 different lines + common suffix
    // Middle is 1200x1200 = 1.44M cells, exceeds threshold -> inner fallback
    const prefix = Array.from({ length: 50 }, (_, i) => `shared-prefix-${i}`);
    const suffix = Array.from({ length: 50 }, (_, i) => `shared-suffix-${i}`);
    const oldMiddle = Array.from({ length: 1200 }, (_, i) => `old-middle-${i}`);
    const newMiddle = Array.from({ length: 1200 }, (_, i) => `new-middle-${i}`);

    const oldText = [...prefix, ...oldMiddle, ...suffix].join('\n');
    const newText = [...prefix, ...newMiddle, ...suffix].join('\n');

    const start = Date.now();
    const diff = computeDiff(oldText, newText);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    // Prefix and suffix should be 'same'
    const same = diff.filter((l) => l.type === 'same');
    expect(same.length).toBe(100); // 50 prefix + 50 suffix
    // Middle should be all removed + all added
    expect(diff.filter((l) => l.type === 'removed').length).toBe(1200);
    expect(diff.filter((l) => l.type === 'added').length).toBe(1200);
  });

  it('marks only the changed lines when the edits in a large file are far apart (#188)', () => {
    // The changed middle runs from line 10 to line 2900, far past the
    // one-million-cell table the LCS diff allows. It used to come back as
    // 2,891 lines removed and 2,891 added.
    const oldLines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}.`);
    const newLines = [...oldLines];
    newLines[9] = 'Line 10, edited.';
    newLines[2899] = 'Line 2900, edited.';

    const diff = computeDiff(oldLines.join('\n'), newLines.join('\n'));

    expect(diff.filter((l) => l.type === 'removed').map((l) => l.text)).toEqual([
      'Line 10.',
      'Line 2900.',
    ]);
    expect(diff.filter((l) => l.type === 'added').map((l) => l.text)).toEqual([
      'Line 10, edited.',
      'Line 2900, edited.',
    ]);
    expect(diff.filter((l) => l.type === 'same')).toHaveLength(2998);
  });
});

describe('myersLineDiff', () => {
  // A seeded generator, so a failure names a case that reruns the same way.
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Few distinct lines, so repeats and ambiguous alignments are common.
  const randomLines = (next: () => number) =>
    Array.from({ length: Math.floor(next() * 13) }, () => `l${Math.floor(next() * 4)}`);

  function lcsLength(a: string[], b: string[]): number {
    const row = new Array(b.length + 1).fill(0);
    for (const x of a) {
      let diag = 0;
      for (let j = 1; j <= b.length; j++) {
        const up = row[j];
        row[j] = x === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
        diag = up;
      }
    }
    return row[b.length];
  }

  const side = (diff: DiffLine[], kind: 'removed' | 'added') =>
    diff.filter((l) => l.type === 'same' || l.type === kind);

  it('agrees with the LCS diff and rebuilds both texts on 3,000 random pairs', () => {
    const next = rng(188);
    for (let run = 0; run < 3000; run++) {
      const a = randomLines(next);
      const b = randomLines(next);
      const diff = myersLineDiff(a, b, Infinity)!;
      const context = `run ${run}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`;

      // Minimal: as many unchanged lines as a longest common subsequence.
      expect(diff.filter((l) => l.type === 'same').length, context).toBe(lcsLength(a, b));
      // Both texts come back exactly, numbered 1..N and 1..M without gaps.
      const oldSide = side(diff, 'removed');
      expect(
        oldSide.map((l) => l.text),
        context,
      ).toEqual(a);
      expect(
        oldSide.map((l) => l.oldLineNo),
        context,
      ).toEqual(a.map((_, i) => i + 1));
      const newSide = side(diff, 'added');
      expect(
        newSide.map((l) => l.text),
        context,
      ).toEqual(b);
      expect(
        newSide.map((l) => l.newLineNo),
        context,
      ).toEqual(b.map((_, i) => i + 1));
      // Within each run of changes, removed lines come first.
      for (let i = 1; i < diff.length; i++) {
        expect(diff[i - 1].type === 'added' && diff[i].type === 'removed', context).toBe(false);
      }
    }
  });

  it('gives up past the edit limit, so the caller can fall back', () => {
    expect(myersLineDiff(['a', 'b', 'c'], ['x', 'y', 'z'], 5)).toBeNull();
    expect(myersLineDiff(['a', 'b', 'c'], ['x', 'y', 'z'], 6)).not.toBeNull();
  });

  it('keeps the remove-then-add fallback for a large middle that is mostly new', () => {
    // 3,000 lines with nothing in common is far past MAX_EDIT_DISTANCE.
    const oldLines = Array.from({ length: 3000 }, (_, i) => `old ${i}`);
    const newLines = Array.from({ length: 3000 }, (_, i) => `new ${i}`);
    expect(oldLines.length + newLines.length).toBeGreaterThan(MAX_EDIT_DISTANCE);

    const diff = computeDiff(oldLines.join('\n'), newLines.join('\n'));
    expect(diff.slice(0, 3000).every((l) => l.type === 'removed')).toBe(true);
    expect(diff.slice(3000).every((l) => l.type === 'added')).toBe(true);
  });
});
