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
