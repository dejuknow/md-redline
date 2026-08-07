export interface CommentReply {
  id: string;
  text: string;
  author: string;
  timestamp: string;
}

export type CommentStatus = 'open' | 'resolved';

export interface MdComment {
  id: string;
  anchor: string;
  text: string;
  author: string;
  timestamp: string;
  resolved?: boolean;
  status?: CommentStatus;
  replies?: CommentReply[];
  /** Surrounding context stored at comment creation time for fuzzy re-matching when anchor text is edited. */
  contextBefore?: string;
  contextAfter?: string;
  /** Character offset of the anchor's start position in the clean markdown. Computed at parse time, not stored in the file. */
  cleanOffset?: number;
  /**
   * True when `anchor` no longer resolves against the document. Computed at
   * parse time, not stored in the file. Set regardless of status, so a
   * resolved comment detached by a later rewrite is still visible as such.
   */
  anchorStale?: boolean;
  /**
   * Replacement anchor derived from the marker's own position when `anchor`
   * went stale — a marker sits immediately before the text it anchors to, so
   * the text now following it is the best available candidate. Computed at
   * parse time, not stored in the file: the reviewer makes it permanent by
   * re-anchoring to a selection.
   *
   * Its PRESENCE is load-bearing, not just its value: a comment carrying one
   * is excluded from `detectMissingAnchors` (it is attached, just not where it
   * was written) and so never reaches the "Needs re-anchoring" section. It is
   * therefore only ever set to a string that resolves against the document —
   * setting an unlocatable one would suppress the orphan badge while the
   * viewer highlighted nothing.
   */
  recoveredAnchor?: string;
  /**
   * True when this marker was inserted by ANY agent tool (mdr_ask or
   * fire-and-forget mdr_review). Drives sidebar section + card styling.
   * Use `expectsReply` to distinguish "agent question I need to answer"
   * from "agent comment posted for context".
   */
  agentInitiated?: boolean;
  /**
   * True when the agent is actively blocking on a reply from the user
   * (mdr_ask). False/absent for fire-and-forget mdr_review comments. The
   * UI uses this to gate the "agent has a question" toast / palette entry
   * — without the field, fire-and-forget reviews would falsely surface as
   * pending questions.
   *
   * Lifecycle: set to true by /agent-comments when mode='ask'. Removed by
   * `addReply` (user reply via sidebar) and `appendReply` (any reply land —
   * agent-self-reply included). Also removed by the partial-reply cleanup
   * path on /asks/:askId/reply for questions the user explicitly left
   * unanswered (closed without reply). A marker without expectsReply that
   * still has agentInitiated:true is "asked, closed" — a record of the
   * question, no longer pending.
   */
  expectsReply?: boolean;
  /** Review session that owns this agent comment. Used for reply routing. */
  sessionId?: string;
}

/**
 * The anchor as the reviewer actually sees it: the recovered text when the
 * stored anchor went stale and recovery found what replaced it, otherwise the
 * stored anchor. Anything the reviewer reads, copies, or navigates by should
 * go through this, or the app shows one string and acts on another.
 */
export function displayAnchor(comment: MdComment): string {
  return comment.recoveredAnchor ?? comment.anchor;
}

/**
 * Lowercased haystack for comment search. Both anchors are included on
 * purpose: the recovered text is what is on screen to search for, and the
 * original is what the reviewer remembers writing the comment against.
 */
export function anchorSearchText(comment: MdComment): string {
  return comment.recoveredAnchor
    ? `${comment.anchor}\n${comment.recoveredAnchor}`.toLowerCase()
    : comment.anchor.toLowerCase();
}

export function getEffectiveStatus(comment: MdComment): CommentStatus {
  const status = comment.status as string | undefined;
  if (status === 'open' || status === 'resolved') return status;
  if (status === 'accepted' || comment.resolved) return 'resolved';
  return 'open';
}

export interface ParseResult {
  cleanMarkdown: string;
  comments: MdComment[];
  cleanToRawOffset: (cleanOffset: number) => number;
}

export interface SelectionInfo {
  text: string;
  /**
   * The selection serialized as HTML, snapshotted before the viewer's highlight
   * repaint destroys the range. Feeds the clipboard's rich-text flavor.
   */
  html?: string;
  rect: DOMRect;
  contextBefore: string;
  contextAfter: string;
  /** Character offset of the selection start within the container's text content. */
  offset: number;
}
