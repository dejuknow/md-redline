export function getPathBasename(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Replace a leading home-directory prefix with `~` for compact display.
 * Returns the original path unchanged if it does not start with the home dir,
 * or if the home dir is empty. Only the leading prefix is substituted; later
 * occurrences of the home dir string are left alone.
 */
export function tildeShortenPath(path: string, homeDir: string): string {
  if (!path || !homeDir) return path;
  // Strip any trailing slash on the home dir before comparison so the
  // substitution works for both `/Users/dennisju` and `/Users/dennisju/`.
  const normalizedHome = homeDir.replace(/[\\/]+$/, '');
  if (!normalizedHome) return path;
  if (path === normalizedHome) return '~';
  if (path.startsWith(normalizedHome + '/')) {
    return '~' + path.slice(normalizedHome.length);
  }
  if (path.startsWith(normalizedHome + '\\')) {
    return '~' + path.slice(normalizedHome.length);
  }
  return path;
}

/**
 * Shorten a long path for display by eliding whole directory segments from the
 * middle: `/private/tmp/…/scratchpad` rather than a hard character cut, which
 * chops names in half and hides exactly the segment that identifies the folder.
 * The first and last segments always survive, so the result still reads as
 * "somewhere under /private/tmp, in scratchpad". Returns the path unchanged
 * when it already fits or has too few segments to elide anything.
 */
export function middleTruncatePath(path: string, maxLength = 44): string {
  if (!path || path.length <= maxLength) return path;
  // A path with no forward slash at all is Windows-style; anything else keeps
  // POSIX separators, including a mixed path, which is legal on Windows.
  const sep = path.includes('/') ? '/' : '\\';
  // Preserved verbatim (normalized to one separator style) so a UNC path keeps
  // both of its leading slashes: `\\fileserver\…` is a different machine from
  // `\fileserver\…`, and collapsing the prefix would claim the wrong one.
  const leadingMatch = /^[\\/]+/.exec(path);
  const leading = leadingMatch ? leadingMatch[0].replace(/[\\/]/g, sep) : '';
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 3) return path;

  // Two leading segments where there is room for them, since `/private/tmp/…`
  // places the folder in a way `/private/…` does not. The head shrinks too when
  // it is what blows the budget: `/Volumes/My Passport for Mac 4TB/…` cannot
  // pay for itself, and a head kept at any cost pushes the result back over
  // maxLength and hands the overflow to the caller's CSS.
  for (const headCount of [2, 1, 0]) {
    if (headCount >= segments.length) continue;
    const head = segments.slice(0, headCount);
    // Shrink the tail one segment at a time and stop at the first fit.
    for (let tailCount = segments.length - headCount - 1; tailCount >= 1; tailCount--) {
      const candidate = leading + [...head, '…', ...segments.slice(-tailCount)].join(sep);
      if (candidate.length <= maxLength) return candidate;
    }
  }
  // Even `…/name` overflows, so the final segment alone is over budget. Keep it
  // whole: half a folder name identifies nothing, and the caller clips.
  return leading + ['…', segments[segments.length - 1]].join(sep);
}

/**
 * Directory portion of a path, for both POSIX and Windows separators.
 * Returns an empty string when the path has no directory part, so callers can
 * tell "no parent" from "the root". A POSIX root (`/`) is its own parent; a
 * bare drive (`C:\`) has no parent and returns an empty string.
 */
export function getParentDir(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path.slice(0, 1);
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSep < 0) return '';
  if (lastSep === 0) return trimmed.slice(0, 1);
  // A drive root keeps its separator: "C:\\file.md" -> "C:\\".
  const parent = trimmed.slice(0, lastSep);
  return /^[A-Za-z]:$/.test(parent) ? parent + trimmed[lastSep] : parent;
}
