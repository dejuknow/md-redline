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
  rect: DOMRect;
  contextBefore: string;
  contextAfter: string;
  /** Character offset of the selection start within the container's text content. */
  offset: number;
}
