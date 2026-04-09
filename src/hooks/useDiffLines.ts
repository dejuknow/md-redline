import { useMemo } from 'react';
import { computeDiff, type DiffLine } from '../lib/diff';
import { parseComments } from '../lib/comment-parser';

/**
 * Single source of truth for diff state, computed once at the App level so
 * the raw view, rendered view, and panel toolbar badge all see the exact
 * same change set. Returns null when there is no snapshot to diff against.
 *
 * `chunkCount` counts contiguous runs of changed lines (one paired
 * removed+added group counts as a single chunk), matching the chunk model
 * both raw and rendered navigation use.
 *
 * `oldCleanToRawLine` / `newCleanToRawLine` map a 1-indexed clean line
 * number back to a 0-indexed raw line index. The raw view needs this
 * because diffs are computed on the comment-stripped text but the raw
 * view's row HTML is indexed by raw line — without the map, an edit on
 * the line directly below a `<!-- @comment ... -->` marker would point
 * at the marker row instead of the body row.
 */
export interface DiffState {
  diffLines: DiffLine[] | null;
  chunkCount: number;
  hasSnapshot: boolean;
  oldCleanToRawLine: number[];
  newCleanToRawLine: number[];
}

/**
 * Walk both raw and clean line lists and emit, for each clean line, the
 * index of the corresponding raw line. parseComments strips markers
 * verbatim so we can match by exact string equality and skip raw lines
 * that don't survive into the clean text.
 */
function buildCleanToRawLineMap(rawText: string, cleanText: string): number[] {
  const rawLines = rawText.split('\n');
  const cleanLines = cleanText.split('\n');
  const map: number[] = [];
  let r = 0;
  for (let c = 0; c < cleanLines.length; c++) {
    while (r < rawLines.length && rawLines[r] !== cleanLines[c]) r++;
    // Defensive clamp: parseComments only ever drops raw lines, so every
    // clean line MUST appear in raw and the walker should always find a
    // match. If invariants ever break (e.g. a future parser change emits a
    // synthesized clean line) we'd rather pin to the last raw row than
    // throw at render time and crash the panel.
    map.push(r < rawLines.length ? r : rawLines.length - 1);
    r++;
  }
  return map;
}

export function useDiffLines(
  rawMarkdown: string,
  diffSnapshot: string | null,
): DiffState {
  return useMemo<DiffState>(() => {
    if (diffSnapshot == null) {
      return {
        diffLines: null,
        chunkCount: 0,
        hasSnapshot: false,
        oldCleanToRawLine: [],
        newCleanToRawLine: [],
      };
    }
    const { cleanMarkdown: oldClean } = parseComments(diffSnapshot);
    const { cleanMarkdown: newClean } = parseComments(rawMarkdown);
    const diffLines = computeDiff(oldClean, newClean);
    let chunks = 0;
    let inChunk = false;
    for (const line of diffLines) {
      const changed = line.type !== 'same';
      if (changed && !inChunk) {
        chunks++;
        inChunk = true;
      } else if (!changed) {
        inChunk = false;
      }
    }
    return {
      diffLines,
      chunkCount: chunks,
      hasSnapshot: true,
      oldCleanToRawLine: buildCleanToRawLineMap(diffSnapshot, oldClean),
      newCleanToRawLine: buildCleanToRawLineMap(rawMarkdown, newClean),
    };
  }, [rawMarkdown, diffSnapshot]);
}
