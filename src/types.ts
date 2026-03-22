export type CommentStatus = 'open' | 'addressed' | 'accepted' | 'reopened';

export interface CommentReply {
  id: string;
  text: string;
  author: string;
  timestamp: string;
}

export interface MdComment {
  id: string;
  anchor: string;
  text: string;
  author: string;
  timestamp: string;
  resolved: boolean;
  status?: CommentStatus;
  replies?: CommentReply[];
  /** Surrounding context stored at comment creation time for fuzzy re-matching when anchor text is edited. */
  contextBefore?: string;
  contextAfter?: string;
  /** Character offset of the anchor's start position in the clean markdown. Computed at parse time, not stored in the file. */
  cleanOffset?: number;
}

export function getEffectiveStatus(comment: MdComment): CommentStatus {
  if (comment.status) return comment.status;
  return comment.resolved ? 'accepted' : 'open';
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
}
