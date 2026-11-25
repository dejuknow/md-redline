import type { ReviewSession } from '../hooks/useReviewSession';

/** The review the header showed last, and whether its row must hold still. */
export interface ShownSession {
  id: string | null;
  /** The reviewer is pointing at the row or a send of it is in flight. */
  hold?: boolean;
}

/**
 * Which review the app header shows in its one row, and which wait behind the
 * "+N" popover. The row goes to what needs the reviewer most: a review with an
 * agent question waiting on a reply, then a review of the reviewer's own that
 * has comments ready to send, then the first in the order given.
 *
 * Once a review is shown it keeps the row while it exists, so a click never
 * lands on another review's button that just took its place (a send turns
 * this review's Send off and another's on in the same render). It gives the
 * row up only when it no longer needs anything from the reviewer and another
 * review now has a question waiting, and not while `hold` is set.
 *
 * `others` keeps the order given, so the popover's rows do not reshuffle as
 * their states change.
 */
export function pickHeaderSessions(
  sessions: ReviewSession[],
  pendingAsks: Map<string, number>,
  readyToSend: (s: ReviewSession) => boolean,
  shown: ShownSession = { id: null },
): { primary: ReviewSession | null; others: ReviewSession[] } {
  const hasAsks = (s: ReviewSession) => (pendingAsks.get(s.id) ?? 0) > 0;
  const isReady = (s: ReviewSession) => s.origin === 'user' && readyToSend(s);
  const kept = shown.id === null ? undefined : sessions.find((s) => s.id === shown.id);
  const keep =
    kept !== undefined &&
    (shown.hold === true || hasAsks(kept) || isReady(kept) || !sessions.some(hasAsks));
  const primary = keep
    ? kept
    : (sessions.find(hasAsks) ?? sessions.find(isReady) ?? sessions[0] ?? null);
  return { primary, others: sessions.filter((s) => s !== primary) };
}
