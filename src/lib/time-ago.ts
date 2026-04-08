/**
 * Format an ISO-8601 timestamp as a human-readable relative time
 * ("just now", "5m ago", "3h ago", "2d ago"), falling back to the locale
 * date string for anything older than a week.
 *
 * Returns `null` for missing, empty, or unparseable timestamps so callers
 * can render the surrounding UI without a separator. This matters because
 * agent-edited files can land with no `timestamp` field on replies (the
 * agent prompt explicitly tells agents not to write one), and we don't
 * want "Invalid Date" leaking into the UI before the SSE backfill runs.
 */
export function timeAgo(timestamp: string | undefined | null): string | null {
  if (!timestamp) return null;
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;

  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
