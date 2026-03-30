export function getPathBasename(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
