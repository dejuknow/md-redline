// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDiffLines } from './useDiffLines';

const SNAPSHOT = `# Heading

Body line one.
Body line two.
`;

const MARKER_SNAPSHOT = `# Heading

<!-- @comment{"id":"c1","text":"why?","author":"D","timestamp":"2026-01-01T00:00:00.000Z","anchor":"Body line one."} -->
Body line one.
Body line two.
`;

describe('useDiffLines', () => {
  it('returns no-snapshot state when diffSnapshot is null', () => {
    const { result } = renderHook(() => useDiffLines('hello', null));
    expect(result.current.diffLines).toBeNull();
    expect(result.current.chunkCount).toBe(0);
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.oldCleanToRawLine).toEqual([]);
    expect(result.current.newCleanToRawLine).toEqual([]);
  });

  it('returns hasSnapshot=true and zero chunks when content is unchanged', () => {
    const { result } = renderHook(() => useDiffLines(SNAPSHOT, SNAPSHOT));
    expect(result.current.hasSnapshot).toBe(true);
    expect(result.current.chunkCount).toBe(0);
    expect(result.current.diffLines?.every((d) => d.type === 'same')).toBe(true);
  });

  it('counts a single contiguous edit as one chunk', () => {
    const next = SNAPSHOT.replace('Body line one.', 'Body line ONE.');
    const { result } = renderHook(() => useDiffLines(next, SNAPSHOT));
    expect(result.current.chunkCount).toBe(1);
  });

  it('counts two non-adjacent edits as two chunks', () => {
    // Two edits with at least one unchanged line between them: heading on
    // line 1 and "Body line two." on line 4 (separated by the blank line
    // and "Body line one." which both stay the same).
    const farther = SNAPSHOT.replace('# Heading', '# Heading EDIT').replace(
      'Body line two.',
      'Body line TWO.',
    );
    const { result } = renderHook(() => useDiffLines(farther, SNAPSHOT));
    expect(result.current.chunkCount).toBe(2);
  });

  it('treats a comment-only edit as zero content chunks', () => {
    // Same content (cleanMarkdown), only the marker JSON differs.
    const editedMarker = MARKER_SNAPSHOT.replace('"text":"why?"', '"text":"why? UPDATED"');
    const { result } = renderHook(() => useDiffLines(editedMarker, MARKER_SNAPSHOT));
    expect(result.current.chunkCount).toBe(0);
    expect(result.current.diffLines?.every((d) => d.type === 'same')).toBe(true);
  });

  it('builds a clean-to-raw line map that skips marker lines', () => {
    // The marker lives at raw line index 2 (0-indexed). Clean line 2
    // ("Body line one.") maps back to raw line index 3 (the marker is
    // skipped during stripping).
    const { result } = renderHook(() => useDiffLines(MARKER_SNAPSHOT, MARKER_SNAPSHOT));
    const map = result.current.newCleanToRawLine;
    // Clean lines: ['# Heading', '', 'Body line one.', 'Body line two.', '']
    expect(map.length).toBeGreaterThan(0);
    // Find the clean index of "Body line one." and verify it points past the marker.
    const cleanLines = MARKER_SNAPSHOT
      .replace(
        /<!-- @comment\{[^}]*\} -->\n?/,
        '',
      )
      .split('\n');
    const cleanIdx = cleanLines.indexOf('Body line one.');
    expect(cleanIdx).toBeGreaterThanOrEqual(0);
    const rawIdx = map[cleanIdx];
    const rawLines = MARKER_SNAPSHOT.split('\n');
    expect(rawLines[rawIdx]).toBe('Body line one.');
  });

  it('memoizes — same inputs return the same object reference', () => {
    const { result, rerender } = renderHook(
      ({ raw, snap }: { raw: string; snap: string | null }) => useDiffLines(raw, snap),
      { initialProps: { raw: SNAPSHOT, snap: SNAPSHOT } },
    );
    const first = result.current;
    rerender({ raw: SNAPSHOT, snap: SNAPSHOT });
    expect(result.current).toBe(first);
  });
});
