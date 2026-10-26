export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
  oldLineNo?: number;
  newLineNo?: number;
}

/**
 * Line-based diff for rendering. Uses the longest common subsequence table
 * while it stays under 1M cells; larger inputs go to `computeDiffLargeFile`.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // For large inputs, use a chunked approach to avoid O(m*n) memory
  if (m * n > 1_000_000) {
    return computeDiffLargeFile(oldLines, newLines);
  }

  return lcsBasedDiff(oldLines, newLines);
}

/** Standard LCS-based diff for reasonably sized inputs. */
function lcsBasedDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const stack: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'same', text: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', text: newLines[j - 1], newLineNo: j });
      j--;
    } else {
      stack.push({ type: 'removed', text: oldLines[i - 1], oldLineNo: i });
      i--;
    }
  }

  // Reverse since we built it backwards
  const result: DiffLine[] = [];
  for (let k = stack.length - 1; k >= 0; k--) {
    result.push(stack[k]);
  }
  return result;
}

/**
 * For large files: strip the common prefix and suffix, then diff the middle,
 * by LCS when its table fits in 1M cells and by Myers otherwise.
 */
function computeDiffLargeFile(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Emit common prefix
  for (let i = 0; i < prefixLen; i++) {
    result.push({ type: 'same', text: oldLines[i], oldLineNo: i + 1, newLineNo: i + 1 });
  }

  // Diff the middle section
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  // The LCS table grows with the size of the middle; Myers grows with the
  // number of changed lines instead, so two small edits a thousand lines apart
  // still come back as two edits (#188). Only a middle that really is mostly
  // changed falls back to remove-then-add.
  const middleDiff =
    oldMiddle.length * newMiddle.length <= 1_000_000
      ? lcsBasedDiff(oldMiddle, newMiddle)
      : myersLineDiff(oldMiddle, newMiddle, MAX_EDIT_DISTANCE);
  if (middleDiff) {
    for (const line of middleDiff) {
      result.push({
        ...line,
        oldLineNo: line.oldLineNo ? line.oldLineNo + prefixLen : undefined,
        newLineNo: line.newLineNo ? line.newLineNo + prefixLen : undefined,
      });
    }
  } else {
    for (let i = 0; i < oldMiddle.length; i++) {
      result.push({ type: 'removed', text: oldMiddle[i], oldLineNo: prefixLen + i + 1 });
    }
    for (let i = 0; i < newMiddle.length; i++) {
      result.push({ type: 'added', text: newMiddle[i], newLineNo: prefixLen + i + 1 });
    }
  }

  // Emit common suffix
  for (let i = 0; i < suffixLen; i++) {
    const oldIdx = oldLines.length - suffixLen + i;
    const newIdx = newLines.length - suffixLen + i;
    result.push({
      type: 'same',
      text: oldLines[oldIdx],
      oldLineNo: oldIdx + 1,
      newLineNo: newIdx + 1,
    });
  }

  return result;
}

/**
 * The most removed plus added lines `myersLineDiff` will search for. Its
 * backtracking trace holds about this many squared entries, so 2,000 keeps it
 * near 16 MB; past it, the changed region is mostly new text anyway and the
 * remove-then-add fallback reads about as well.
 */
export const MAX_EDIT_DISTANCE = 2_000;

/**
 * Line diff by Myers' algorithm: O((N + M) * D) time for D removed plus added
 * lines, where the LCS table costs O(N * M) whatever changed. The result is
 * minimal, keeping as many lines the same as the LCS diff does. Returns null
 * when more than `maxEdits` lines would have to change. Line numbers start at
 * 1, and within each change removed lines come before added ones, as the diff
 * view expects.
 */
export function myersLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
  maxEdits: number,
): DiffLine[] | null {
  // Compare small integers instead of strings: each distinct line gets an id.
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const a = Int32Array.from(oldLines, intern);
  const b = Int32Array.from(newLines, intern);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  // v[offset + k]: the furthest x reached on diagonal k (k = x - y).
  const v = new Int32Array(2 * max + 3);
  // trace[d]: diagonals -(d+1)..(d+1) of v as they stood before step d, all
  // that backtracking needs from that step.
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEdits) && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  // Walk back from the end, emitting in reverse.
  const reversed: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: 'same', text: oldLines[x - 1], oldLineNo: x, newLineNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ type: 'added', text: newLines[y - 1], newLineNo: y });
      } else {
        reversed.push({ type: 'removed', text: oldLines[x - 1], oldLineNo: x });
      }
    }
    x = prevX;
    y = prevY;
  }
  reversed.reverse();
  return removedBeforeAdded(reversed);
}

/** Reorder each run of changed lines so its removed lines come first. */
function removedBeforeAdded(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    result.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.type === 'removed') removed.push(line);
    else if (line.type === 'added') added.push(line);
    else {
      flush();
      result.push(line);
    }
  }
  flush();
  return result;
}
