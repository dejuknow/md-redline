import type { ReviewSession } from '../hooks/useReviewSession';

/**
 * Which review the app header shows in its one row, and which wait behind the
 * "+N" popover. The row goes to what needs the reviewer most: a review with an
 * agent question waiting on a reply, then a review of the reviewer's own that
 * has comments ready to send, then the first in the order given. `others`
 * keeps the order given, so the popover's rows do not reshuffle as their
 * states change.
 */
export function pickHeaderSessions(
  sessions: ReviewSession[],
  pendingAsks: Map<string, number>,
  readyToSend: (s: ReviewSession) => boolean,
): { primary: ReviewSession | null; others: ReviewSession[] } {
  const primary =
    sessions.find((s) => (pendingAsks.get(s.id) ?? 0) > 0) ??
    sessions.find((s) => s.origin === 'user' && readyToSend(s)) ??
    sessions[0] ??
    null;
  return { primary, others: sessions.filter((s) => s !== primary) };
}
