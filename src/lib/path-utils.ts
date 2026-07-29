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
