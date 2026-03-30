export type CommentCardEditorState =
  | { mode: 'comment-edit'; token: number }
  | { mode: 'reply-compose'; token: number }
  | { mode: 'reply-edit'; replyId: string; token: number };

export type SidebarCommentEditorState = ({ commentId: string } & CommentCardEditorState) | null;
