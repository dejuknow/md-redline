import type { MdComment } from '../types';

/**
 * Ids of comments whose thread carries a reply from someone other than
 * whoever raised it.
 *
 * This is remove mode's only durable progress signal. It keeps no resolved
 * status, and a question's marker now survives the round that answered it, so
 * without this an answered question looks exactly like one the agent never
 * reached.
 *
 * Both names are read out of the file, deliberately. An earlier version
 * compared each reply against the reader's live display name, which rewrote
 * history on every rename: changing yourself from "Dennis" to "Dennis J" made
 * every comment you had self-replied to flip to answered at once, because the
 * stored reply author stopped matching you. Marker authors do not move.
 *
 * An unattributed reply counts as unanswered. A false negative costs a glance
 * at a card; a false positive hides a question that never got an answer.
 */
export function computeAnsweredCommentIds(comments: readonly MdComment[]): Set<string> {
  return new Set(
    comments
      .filter((c) => c.replies?.some((r) => r.author && r.author !== c.author))
      .map((c) => c.id),
  );
}
