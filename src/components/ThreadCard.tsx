import { useState } from 'react';
import type { MdComment } from '../types';
import type { SidebarCommentEditorState } from '../lib/comment-editor-state';
import { CommentCard } from './CommentCard';

export interface ThreadCardProps {
  thread: MdComment;
  active: boolean;
  /** Ref callback for the wrapper div — used by parent to scroll this card into view. */
  divRef?: (node: HTMLDivElement | null) => void;
  /** If the anchor text is missing from the document (orphan state). */
  anchorMissing?: boolean;
  /** Whether this comment has already been sent to the reviewing agent. */
  sent?: boolean;
  /** Optional externally-managed editor state. When omitted, ThreadCard manages editor state internally. */
  editor?: SidebarCommentEditorState;
  onRequestCommentEdit?: (commentId: string) => void;
  onRequestReplyCompose?: (commentId: string) => void;
  onRequestReplyEdit?: (commentId: string, replyId: string) => void;
  onCloseEditor?: () => void;
  onSelect: (id: string) => void;
  onReply: (commentId: string, text: string) => void;
  onResolve?: (commentId: string) => void;
  onUnresolve?: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, newText: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  showAnchorContext?: boolean;
  selectionText?: string | null;
  selectionOffset?: number | null;
  onReanchorToSelection?: (commentId: string, newAnchor: string, hintOffset?: number) => void;
}

/**
 * Renders a single comment thread (anchor, body, replies, reply composer) using CommentCard.
 *
 * When `editor` is undefined, ThreadCard manages its own editor state internally.
 * This is the case for MermaidThreadPanel. CommentSidebar passes an external editor
 * to maintain its shared-editor-state behaviour across all cards.
 */
export function ThreadCard({
  thread,
  active,
  divRef,
  anchorMissing,
  sent,
  editor: externalEditor,
  onRequestCommentEdit: externalRequestCommentEdit,
  onRequestReplyCompose: externalRequestReplyCompose,
  onRequestReplyEdit: externalRequestReplyEdit,
  onCloseEditor: externalCloseEditor,
  onSelect,
  onReply,
  onResolve,
  onUnresolve,
  onDelete,
  onEdit,
  onEditReply,
  onDeleteReply,
  onContextMenu,
  showAnchorContext,
  selectionText,
  selectionOffset,
  onReanchorToSelection,
}: ThreadCardProps) {
  // Internal editor state used when no external editor management is provided.
  const [internalEditor, setInternalEditor] = useState<SidebarCommentEditorState>(null);

  const externalEditorMode = externalEditor !== undefined;

  const editor = externalEditorMode ? externalEditor ?? null : internalEditor;

  const openCommentEdit = externalEditorMode
    ? (externalRequestCommentEdit ?? (() => {}))
    : (commentId: string) =>
        setInternalEditor({ mode: 'comment-edit', commentId, token: Date.now() });

  const openReplyCompose = externalEditorMode
    ? (externalRequestReplyCompose ?? (() => {}))
    : (commentId: string) =>
        setInternalEditor({ mode: 'reply-compose', commentId, token: Date.now() });

  const openReplyEdit = externalEditorMode
    ? (externalRequestReplyEdit ?? (() => {}))
    : (commentId: string, replyId: string) =>
        setInternalEditor({ mode: 'reply-edit', commentId, replyId, token: Date.now() });

  const closeEditor = externalEditorMode
    ? (externalCloseEditor ?? (() => {}))
    : () => setInternalEditor(null);

  return (
    <div
      ref={divRef}
      tabIndex={-1}
      data-comment-card-id={thread.id}
    >
      <CommentCard
        comment={thread}
        isActive={active}
        anchorMissing={anchorMissing}
        sent={sent}
        onActivate={onSelect}
        onResolve={onResolve}
        onUnresolve={onUnresolve}
        onDelete={onDelete}
        onEdit={onEdit}
        onReply={onReply}
        onEditReply={onEditReply}
        onDeleteReply={onDeleteReply}
        editor={editor?.commentId === thread.id ? editor : null}
        onRequestCommentEdit={openCommentEdit}
        onRequestReplyCompose={openReplyCompose}
        onRequestReplyEdit={openReplyEdit}
        onCloseEditor={closeEditor}
        onContextMenu={onContextMenu}
        showAnchorContext={showAnchorContext}
        selectionText={selectionText}
        selectionOffset={selectionOffset}
        onReanchorToSelection={onReanchorToSelection}
      />
    </div>
  );
}
