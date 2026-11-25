import type { ReviewSession } from '../hooks/useReviewSession';

/** The review the header showed last, and whether its row must hold still. */
export interface ShownSession {
  id: string | null;
  /** The pointer is over the row, or an action of the shown review is in flight. */
  hold?: boolean;
}

/**
 * Which review the app header shows in its one row, and which wait behind the
 * "+N" popover. The row goes to what needs the reviewer most: a review with an
 * agent question waiting on a reply, then a review of the reviewer's own that
 * has comments ready to send, then the first in the order given. Ties keep the
 * order given.
 *
 * While `hold` is set the shown review keeps the row, so a click never lands
 * on another review's button that just took its place. A held review that
 * ended gives the row to the next by priority; `heldEnded` says so, and the
 * caller keeps that row's actions inert until the pointer leaves.
 *
 * `others` keeps the order given, so the popover's rows do not reshuffle as
 * their states change.
 */
export function pickHeaderSessions(
  sessions: ReviewSession[],
  pendingAsks: Map<string, number>,
  readyToSend: (s: ReviewSession) => boolean,
  shown: ShownSession = { id: null },
): { primary: ReviewSession | null; others: ReviewSession[]; heldEnded: boolean } {
  const hasAsks = (s: ReviewSession) => (pendingAsks.get(s.id) ?? 0) > 0;
  const isReady = (s: ReviewSession) => s.origin === 'user' && readyToSend(s);
  const held = shown.hold === true && shown.id !== null;
  const kept = held ? sessions.find((s) => s.id === shown.id) : undefined;
  const primary = kept ?? sessions.find(hasAsks) ?? sessions.find(isReady) ?? sessions[0] ?? null;
  return {
    primary,
    others: sessions.filter((s) => s !== primary),
    heldEnded: held && kept === undefined,
  };
}
