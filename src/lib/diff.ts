export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
  oldLineNo?: number;
  newLineNo?: number;
}

/**
 * Simple line-based diff using the longest common subsequence algorithm.
 * Returns an array of DiffLine objects for rendering.
 *
 * For large files (where the DP table would exceed 1M cells), uses a
 * hash-based pre-filtering approach to keep memory usage bounded.
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
 * For large files: strip common prefix/suffix, then apply LCS to the
 * remaining (typically much smaller) changed region.
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

  if (oldMiddle.length * newMiddle.length <= 1_000_000) {
    // Middle is small enough for standard LCS
    const middleDiff = lcsBasedDiff(oldMiddle, newMiddle);
    for (const line of middleDiff) {
      result.push({
        ...line,
        oldLineNo: line.oldLineNo ? line.oldLineNo + prefixLen : undefined,
        newLineNo: line.newLineNo ? line.newLineNo + prefixLen : undefined,
      });
    }
  } else {
    // Still too large — fall back to simple remove-then-add
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
