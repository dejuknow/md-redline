import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';

/**
 * Ids of comments whose thread carries a reply from someone other than
 * whoever raised it.
 *
 * This is remove mode's only durable progress signal. It keeps no resolved
 * status, and a question's marker now survives the round that answered it, so
 * without this an answered question looks exactly like one the agent never
 * reached.
 *
 * Each reply's own `agent` stamp decides when it has one (#102). For replies
 * written before the stamp existed, the rest of this note applies: both names
 * are read out of the file, deliberately. An earlier version
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
    comments.filter((c) => c.replies?.some((r) => isAgentReply(r, c.author))).map((c) => c.id),
  );
}

/**
 * Identifies a reply by its id and its text. `editReply` keeps the id, so the
 * id alone would call a corrected reply already sent and the correction would
 * never reach the agent. The hash is only there to tell two texts apart, not to
 * protect anything, so a small string hash (djb2) is enough.
 */
export function replyKey(reply: NonNullable<MdComment['replies']>[number]): string {
  // A render path again: a hand-edited marker can lack the text.
  const text = typeof reply.text === 'string' ? reply.text : '';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
  }
  return `${reply.id}~${hash.toString(36)}`;
}

/**
 * Open comments whose last reply is not an agent's, mapped to that reply's key
 * (`replyKey`): the reviewer answered after the agent's last reply, so the
 * thread needs the agent again even when it was sent in an earlier batch.
 * Without this a reply on a sent thread never enables Send and never reaches
 * the agent.
 *
 * The key is what separates "this reply already went out" from "a newer one is
 * waiting": a sent thread counts as unsent again only for a reply the session
 * has not recorded as sent, and an edited reply is a new key. A resolved thread
 * is left out in either mode: a closing "thanks" must not send it back, and no
 * card offers a reply field on a resolved thread to begin with (#159).
 */
export function computeUserRepliedLast(comments: readonly MdComment[]): Map<string, string> {
  const lastReplyKeys = new Map<string, string>();
  for (const c of comments) {
    const last = c.replies?.[c.replies.length - 1];
    if (
      last !== undefined &&
      !isAgentReply(last, c.author) &&
      getEffectiveStatus(c) !== 'resolved'
    ) {
      lastReplyKeys.set(c.id, replyKey(last));
    }
  }
  return lastReplyKeys;
}

/**
 * Whether a comment has gone to the agent as it stands now: its id is sent, and
 * so is the reviewer's last reply on it, when there is one. A sent comment whose
 * last reply key is not in `sentReplyKeys` is waiting on a reply and counts as
 * unsent, which is what keeps the banner's Send and the card's "Sent" badge in
 * agreement.
 */
export function isCommentSent(
  id: string,
  sentCommentIds: ReadonlySet<string>,
  sentReplyKeys: ReadonlySet<string>,
  userRepliedLast: ReadonlyMap<string, string>,
): boolean {
  if (!sentCommentIds.has(id)) return false;
  const lastReplyKey = userRepliedLast.get(id);
  return lastReplyKey === undefined || sentReplyKeys.has(lastReplyKey);
}

/**
 * The ids the cards and highlights show as "Sent": every id a session recorded
 * or this tab just sent, minus those waiting on a reviewer reply that has not
 * gone out. Order follows `serverIds`, then `optimisticIds`.
 */
export function effectiveSentCommentIds(
  serverIds: readonly string[],
  optimisticIds: readonly string[],
  userRepliedLast: ReadonlyMap<string, string>,
  sentReplyKeys: readonly string[],
): string[] {
  const sentIds = new Set([...serverIds, ...optimisticIds]);
  const sentKeys = new Set(sentReplyKeys);
  return [...sentIds].filter((id) => isCommentSent(id, sentIds, sentKeys, userRepliedLast));
}

/**
 * A reply's own stamp when it has one (#102): comparing names mistook a
 * colleague's reply, or the reader's own after a rename, for an agent's.
 * Replies written before the stamp existed fall back to that comparison.
 */
function isAgentReply(
  reply: NonNullable<MdComment['replies']>[number],
  commentAuthor: string,
): boolean {
  // Only a real boolean: a hand-edited "true" or 1 is not mdr's stamp, and
  // falls back like an unstamped reply rather than reading as a person's.
  if (typeof reply.agent === 'boolean') return reply.agent;
  return Boolean(reply.author) && reply.author !== commentAuthor;
}
