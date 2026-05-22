import { getEffectiveStatus, type MdComment } from '../types';

/**
 * Return the agent comments that represent a PENDING question (mdr_ask) the
 * user has not yet replied to. Fire-and-forget mdr_review comments are
 * excluded — they're not questions to answer, just informational markers.
 *
 * The discriminators are:
 *   - `expectsReply === true` distinguishes mdr_ask from mdr_review.
 *   - An empty/absent `replies` array distinguishes "still waiting on user"
 *     from "user already replied." Once the user types a reply via the
 *     sidebar, that reply lands in the marker's replies array on disk; the
 *     marker is no longer pending and should drop out of the toast / palette
 *     entry so the user isn't pestered to re-answer an already-answered Q.
 *   - `getEffectiveStatus(c) === 'open'` excludes resolved markers. A user
 *     who resolves an agent ask via the sidebar (without typing a reply) has
 *     deliberately closed the question; surfacing it as "pending" would be
 *     wrong.
 *
 * Comments authored by older code that did not stamp `expectsReply` are not
 * surfaced as asks (safe default — no spurious toasts).
 */
export function selectAgentAsks(comments: MdComment[], activeSessionId: string | null): MdComment[] {
  if (!activeSessionId) return [];
  return comments.filter(
    (c) =>
      c.agentInitiated === true &&
      c.expectsReply === true &&
      c.sessionId === activeSessionId &&
      (!c.replies || c.replies.length === 0) &&
      getEffectiveStatus(c) === 'open',
  );
}
