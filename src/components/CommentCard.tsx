import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  memo,
  useCallback,
  type MouseEventHandler,
} from 'react';
import type { MdComment, CommentStatus } from '../types';
import { getEffectiveStatus } from '../types';
import { getAuthorColor } from '../hooks/useAuthor';
import { useAutoResize } from '../hooks/useAutoResize';
import { useSettings } from '../contexts/SettingsContext';
import type { CommentCardEditorState } from '../lib/comment-editor-state';
import { timeAgo } from '../lib/time-ago';
import { ActionButton } from './ActionButton';

interface Props {
  comment: MdComment;
  isActive: boolean;
  anchorMissing?: boolean;
  sent?: boolean;
  onActivate: (id: string) => void;
  onResolve?: (id: string) => void;
  onUnresolve?: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReply: (id: string, text: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
  editor: CommentCardEditorState | null;
  onRequestCommentEdit: (commentId: string) => void;
  onRequestReplyCompose: (commentId: string) => void;
  onRequestReplyEdit: (commentId: string, replyId: string) => void;
  onCloseEditor: () => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
}

const STATUS_CONFIG: Record<CommentStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-status-open-bg text-status-open-text' },
  resolved: { label: 'Resolved', className: 'bg-status-resolved-bg text-status-resolved-text' },
};

export const CommentCard = memo(function CommentCard({
  comment,
  isActive,
  anchorMissing,
  sent,
  onActivate,
  onResolve,
  onUnresolve,
  onDelete,
  onEdit,
  onReply,
  onEditReply,
  onDeleteReply,
  editor,
  onRequestCommentEdit,
  onRequestReplyCompose,
  onRequestReplyEdit,
  onCloseEditor,
  onContextMenu: onCtxMenu,
}: Props) {
  const { settings } = useSettings();
  const COMMENT_MAX_LENGTH = settings.commentMaxLength;
  const resolveEnabled = settings.enableResolve;
  const status = getEffectiveStatus(comment);
  const isResolved = resolveEnabled && status === 'resolved';
  const commentTimeAgo = timeAgo(comment.timestamp);
  const [editText, setEditText] = useState(comment.text);
  const [replyText, setReplyText] = useState('');
  const [editReplyText, setEditReplyText] = useState('');
  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClamped, setIsClamped] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const editReplyRef = useRef<HTMLTextAreaElement>(null);
  const resizeEditTextarea = useAutoResize(textareaRef, editText);
  useAutoResize(replyRef, replyText);
  const resizeEditReplyTextarea = useAutoResize(editReplyRef, editReplyText);
  const isEditing = editor?.mode === 'comment-edit';
  const isReplying = editor?.mode === 'reply-compose';
  const editingReplyId = editor?.mode === 'reply-edit' ? editor.replyId : null;
  const editorToken = editor?.token ?? 0;

  // Detect if comment text is long enough to need clamping
  const checkClamped = useCallback(() => {
    const el = textRef.current;
    if (el) setIsClamped(el.scrollHeight > el.clientHeight);
  }, []);

  useLayoutEffect(() => {
    checkClamped();
  }, [comment.text, isTextExpanded, checkClamped]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      resizeEditTextarea();
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing, resizeEditTextarea, editorToken]);

  useEffect(() => {
    if (isReplying && replyRef.current) {
      replyRef.current.focus();
    }
  }, [isReplying, editorToken]);

  useEffect(() => {
    if (editingReplyId && editReplyRef.current) {
      resizeEditReplyTextarea();
      editReplyRef.current.focus();
      editReplyRef.current.selectionStart = editReplyRef.current.value.length;
    }
  }, [editingReplyId, resizeEditReplyTextarea, editorToken]);

  useEffect(() => {
    if (editor?.mode === 'comment-edit') {
      setEditText(comment.text);
    }
  }, [editor?.mode, editorToken, comment.text]);

  useEffect(() => {
    if (editor?.mode === 'reply-compose') {
      setReplyText('');
    }
  }, [editor?.mode, editorToken]);

  const handleSave = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== comment.text && trimmed.length <= COMMENT_MAX_LENGTH) {
      onEdit(comment.id, trimmed);
    }
    onCloseEditor();
  };

  const handleCancel = () => {
    setEditText(comment.text);
    onCloseEditor();
  };

  const handleReplySubmit = () => {
    const trimmed = replyText.trim();
    if (trimmed && trimmed.length <= COMMENT_MAX_LENGTH) {
      onReply(comment.id, trimmed);
      setReplyText('');
    }
    onCloseEditor();
  };

  const replies = comment.replies || [];
  const isEditingReply = editingReplyId !== null;
  const editingReply = editingReplyId
    ? (replies.find((reply) => reply.id === editingReplyId) ?? null)
    : null;

  useEffect(() => {
    if (editor?.mode === 'reply-edit') {
      setEditReplyText(editingReply?.text ?? '');
      return;
    }
    if (editingReplyId === null) {
      setEditReplyText('');
    }
  }, [editor?.mode, editorToken, editingReply?.text, editingReplyId]);

  const handleReplyEditSave = () => {
    const trimmed = editReplyText.trim();
    if (
      editingReplyId &&
      editingReply &&
      trimmed &&
      trimmed !== editingReply.text &&
      trimmed.length <= COMMENT_MAX_LENGTH
    ) {
      onEditReply(comment.id, editingReplyId, trimmed);
    }
    setEditReplyText('');
    onCloseEditor();
  };

  const handleReplyEditCancel = () => {
    setEditReplyText('');
    onCloseEditor();
  };

  return (
    <div
      className={`group rounded-lg border transition-all duration-200 cursor-pointer ${
        isActive
          ? 'border-primary-border bg-primary-bg shadow-sm ring-1 ring-primary-ring'
          : isResolved
            ? 'border-border bg-surface-secondary opacity-60'
            : 'border-border-subtle bg-surface hover:border-content-faint hover:shadow-sm'
      }${sent ? ' opacity-50' : ''}`}
      onClick={() => onActivate(comment.id)}
      onContextMenu={(e) => {
        if (onCtxMenu) {
          e.preventDefault();
          onCtxMenu(comment.id, e.clientX, e.clientY);
        }
      }}
    >
      {/* Header: anchor + optional status badge */}
      <div className="px-3 pt-3 pb-1 flex items-start gap-2">
        <div
          className={`text-xs font-mono px-2 py-1 rounded inline-block max-w-full truncate flex-1 min-w-0 ${
            isResolved
              ? 'bg-surface-inset text-content-muted'
              : 'bg-comment-anchor-bg text-comment-anchor-text border border-comment-anchor-border'
          }`}
        >
          &ldquo;{comment.anchor}&rdquo;
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {sent && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap bg-primary-bg-strong text-primary-text"
              title="This comment has been sent to the reviewing agent"
            >
              Sent
            </span>
          )}
          {anchorMissing && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap bg-danger-bg text-danger-text"
              title="Anchor text was modified or removed"
            >
              Changed
            </span>
          )}
          {resolveEnabled && (
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_CONFIG[status].className}`}
            >
              {STATUS_CONFIG[status].label}
            </span>
          )}
        </div>
      </div>

      {/* Comment text */}
      <div className="px-3 py-2">
        {isEditing ? (
          <div className="flex flex-col-reverse gap-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end gap-1.5">
              <ActionButton size="sm" onClick={handleCancel}>
                Cancel
              </ActionButton>
              <ActionButton
                intent="submit"
                size="sm"
                onClick={handleSave}
                disabled={!editText.trim() || editText.length > COMMENT_MAX_LENGTH}
              >
                Save
              </ActionButton>
            </div>
            {editText.length > COMMENT_MAX_LENGTH * 0.8 && (
              <p
                className={`text-right text-xs ${
                  editText.length >= COMMENT_MAX_LENGTH
                    ? 'text-danger font-medium'
                    : 'text-content-muted'
                }`}
              >
                {editText.length}/{COMMENT_MAX_LENGTH}
              </p>
            )}
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSave();
                }
                if (e.key === 'Escape') {
                  handleCancel();
                }
              }}
              maxLength={COMMENT_MAX_LENGTH}
              className="w-full text-sm border border-border-subtle rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none overflow-hidden bg-surface text-content"
              rows={1}
            />
          </div>
        ) : (
          <div>
            <p
              ref={textRef}
              className={`text-sm leading-relaxed whitespace-pre-wrap ${
                isResolved ? 'text-content-muted line-through' : 'text-content'
              } ${!isTextExpanded ? 'line-clamp-4' : ''}`}
            >
              {comment.text}
            </p>
            {(isClamped || isTextExpanded) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsTextExpanded(!isTextExpanded);
                }}
                className="text-xs text-primary-text hover:underline mt-1"
              >
                {isTextExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer: author, time, actions */}
      <div className="px-3 pb-2 flex items-center flex-wrap gap-y-1">
        <span className="text-xs text-content-muted flex items-center gap-1.5 mr-auto">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: getAuthorColor(comment.author).text }}
            title={comment.author}
          />
          {comment.author}
          {commentTimeAgo && <> &middot; {commentTimeAgo}</>}
        </span>

        {!isEditing && !isEditingReply && (
          <div
            className={`flex items-center gap-1 transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          >
            {!isResolved && (
              <>
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestReplyCompose(comment.id);
                  }}
                >
                  Reply
                </ActionButton>
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestCommentEdit(comment.id);
                  }}
                >
                  Edit
                </ActionButton>
              </>
            )}
            {isResolved
              ? onUnresolve && (
                  <ActionButton
                    intent="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnresolve(comment.id);
                    }}
                  >
                    Reopen
                  </ActionButton>
                )
              : onResolve && (
                  <ActionButton
                    intent="success"
                    onClick={(e) => {
                      e.stopPropagation();
                      onResolve(comment.id);
                    }}
                  >
                    Resolve
                  </ActionButton>
                )}
            <DeleteIconButton
              onClick={(e) => {
                e.stopPropagation();
                onDelete(comment.id);
              }}
            />
          </div>
        )}
      </div>

      {/* Replies thread */}
      {replies.length > 0 && (
        <div className="mx-3 mb-2 border-l-2 border-border-subtle pl-3 space-y-2">
          {replies.map((reply) => {
            const replyTimeAgo = timeAgo(reply.timestamp);
            return (
              <div key={reply.id} className="group/reply text-xs" data-reply-id={reply.id}>
                {editingReplyId === reply.id ? (
                  <div
                    className="flex flex-col-reverse gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex justify-end gap-1.5">
                      <ActionButton size="sm" onClick={handleReplyEditCancel}>
                        Cancel
                      </ActionButton>
                      <ActionButton
                        intent="submit"
                        size="sm"
                        onClick={handleReplyEditSave}
                        disabled={
                          !editReplyText.trim() || editReplyText.length > COMMENT_MAX_LENGTH
                        }
                      >
                        Save
                      </ActionButton>
                    </div>
                    {editReplyText.length > COMMENT_MAX_LENGTH * 0.8 && (
                      <p
                        className={`text-right text-xs ${
                          editReplyText.length >= COMMENT_MAX_LENGTH
                            ? 'text-danger font-medium'
                            : 'text-content-muted'
                        }`}
                      >
                        {editReplyText.length}/{COMMENT_MAX_LENGTH}
                      </p>
                    )}
                    <textarea
                      ref={editReplyRef}
                      value={editReplyText}
                      onChange={(e) => setEditReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleReplyEditSave();
                        }
                        if (e.key === 'Escape') {
                          handleReplyEditCancel();
                        }
                      }}
                      maxLength={COMMENT_MAX_LENGTH}
                      className="w-full text-sm border border-border-subtle rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none overflow-hidden bg-surface text-content"
                      rows={1}
                    />
                  </div>
                ) : (
                  <>
                    <p className="text-content-secondary leading-relaxed whitespace-pre-wrap">
                      {reply.text}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="min-w-0 flex flex-1 items-center gap-1 text-content-muted">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: getAuthorColor(reply.author).text }}
                        />
                        {reply.author}
                        {replyTimeAgo && <> &middot; {replyTimeAgo}</>}
                      </span>
                      {!isResolved && (
                        <div
                          className="invisible flex shrink-0 items-center gap-1 pl-2 opacity-0 transition-opacity group-hover/reply:visible group-hover/reply:opacity-100 group-focus-within/reply:visible group-focus-within/reply:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ActionButton
                            onClick={() => {
                              onRequestReplyEdit(comment.id, reply.id);
                            }}
                          >
                            Edit
                          </ActionButton>
                          <DeleteIconButton
                            onClick={() => {
                              onDeleteReply(comment.id, reply.id);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reply input (shown when replying — trigger is in the action bar above) */}
      {!isResolved && isReplying && (
        <div className="px-3 pb-3" onClick={(e) => e.stopPropagation()}>
          <textarea
            ref={replyRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleReplySubmit();
              }
              if (e.key === 'Escape') {
                setReplyText('');
                onCloseEditor();
              }
            }}
            placeholder="Write a reply..."
            maxLength={COMMENT_MAX_LENGTH}
            className="w-full text-xs border border-border-subtle rounded-md px-2 py-1.5 resize-none overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content"
            rows={1}
          />
          {replyText.length > COMMENT_MAX_LENGTH * 0.8 && (
            <p
              className={`text-right text-xs mt-0.5 ${
                replyText.length >= COMMENT_MAX_LENGTH
                  ? 'text-danger font-medium'
                  : 'text-content-muted'
              }`}
            >
              {replyText.length}/{COMMENT_MAX_LENGTH}
            </p>
          )}
          <div className="flex justify-end gap-1.5 mt-1">
            <ActionButton
              onClick={() => {
                setReplyText('');
                onCloseEditor();
              }}
            >
              Cancel
            </ActionButton>
            <ActionButton
              intent="submit"
              onClick={handleReplySubmit}
              disabled={!replyText.trim() || replyText.length > COMMENT_MAX_LENGTH}
            >
              Reply
            </ActionButton>
          </div>
        </div>
      )}
    </div>
  );
});

function DeleteIconButton({ onClick }: { onClick: MouseEventHandler<HTMLButtonElement> }) {
  return (
    <button
      onClick={onClick}
      className="p-1 rounded text-content-muted hover:text-danger hover:bg-tint-danger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      title="Delete"
      aria-label="Delete"
    >
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
        />
      </svg>
    </button>
  );
}
