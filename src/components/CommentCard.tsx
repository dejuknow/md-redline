import { useState, useRef, useEffect, memo } from 'react';
import type { MdComment, CommentStatus } from '../types';
import { getEffectiveStatus } from '../types';

interface Props {
  comment: MdComment;
  isActive: boolean;
  anchorMissing?: boolean;
  onActivate: (id: string) => void;
  onSetStatus: (id: string, status: CommentStatus) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReply: (id: string, text: string) => void;
}

const STATUS_CONFIG: Record<CommentStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-status-open-bg text-status-open-text' },
  addressed: { label: 'Addressed', className: 'bg-status-addressed-bg text-status-addressed-text' },
  accepted: { label: 'Accepted', className: 'bg-status-accepted-bg text-status-accepted-text' },
  reopened: { label: 'Reopened', className: 'bg-status-reopened-bg text-status-reopened-text' },
};

export const CommentCard = memo(function CommentCard({
  comment,
  isActive,
  anchorMissing,
  onActivate,
  onSetStatus,
  onDelete,
  onEdit,
  onReply,
}: Props) {
  const status = getEffectiveStatus(comment);
  const statusConfig = STATUS_CONFIG[status];
  const timeAgo = getTimeAgo(comment.timestamp);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);
  const [isReplying, setIsReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

  useEffect(() => {
    if (isReplying && replyRef.current) {
      replyRef.current.focus();
    }
  }, [isReplying]);

  const handleSave = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== comment.text) {
      onEdit(comment.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditText(comment.text);
    setIsEditing(false);
  };

  const handleReplySubmit = () => {
    const trimmed = replyText.trim();
    if (trimmed) {
      onReply(comment.id, trimmed);
      setReplyText('');
      setIsReplying(false);
    }
  };

  const isResolved = status === 'accepted';
  const replies = comment.replies || [];

  return (
    <div
      className={`group rounded-lg border transition-all duration-200 cursor-pointer ${
        isActive
          ? 'border-primary-border bg-primary-bg shadow-sm ring-1 ring-primary-ring'
          : isResolved
            ? 'border-border bg-surface-secondary opacity-60'
            : 'border-border bg-surface hover:border-content-faint hover:shadow-sm'
      }`}
      onClick={() => onActivate(comment.id)}
    >
      {/* Header: anchor + status badge */}
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
          {anchorMissing && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap bg-danger-bg text-danger-text"
              title="Anchor text was modified or removed"
            >
              Changed
            </span>
          )}
          <span
            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${statusConfig.className}`}
          >
            {statusConfig.label}
          </span>
        </div>
      </div>

      {/* Comment text */}
      <div className="px-3 py-2">
        {isEditing ? (
          <div onClick={(e) => e.stopPropagation()}>
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
              className="w-full text-sm border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none bg-surface text-content"
              rows={3}
            />
            <div className="flex justify-end gap-1.5 mt-1.5">
              <button
                onClick={handleCancel}
                className="text-xs px-2 py-1 rounded text-content-secondary hover:bg-surface-inset transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!editText.trim()}
                className="text-xs px-2 py-1 rounded bg-primary text-on-primary hover:bg-primary-hover transition-colors disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p
            className={`text-sm leading-relaxed ${
              isResolved ? 'text-content-muted line-through' : 'text-content'
            }`}
          >
            {comment.text}
          </p>
        )}
      </div>

      {/* Footer: author, time, actions */}
      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-xs text-content-muted">
          {comment.author} &middot; {timeAgo}
        </span>

        {!isEditing && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {status === 'open' || status === 'reopened' ? (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditText(comment.text);
                    setIsEditing(true);
                  }}
                  className="text-xs px-2 py-0.5 rounded text-content-secondary hover:bg-surface-inset transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetStatus(comment.id, 'addressed');
                  }}
                  className="text-xs px-2 py-0.5 rounded text-warning-text hover:bg-warning-bg transition-colors"
                >
                  Address
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetStatus(comment.id, 'accepted');
                  }}
                  className="text-xs px-2 py-0.5 rounded text-success-text hover:bg-success-bg transition-colors"
                >
                  Resolve
                </button>
              </>
            ) : status === 'addressed' ? (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetStatus(comment.id, 'accepted');
                  }}
                  className="text-xs px-2 py-0.5 rounded text-success-text hover:bg-success-bg transition-colors"
                >
                  Accept
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetStatus(comment.id, 'open');
                  }}
                  className="text-xs px-2 py-0.5 rounded text-warning-text hover:bg-warning-bg transition-colors"
                >
                  Reopen
                </button>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSetStatus(comment.id, 'open');
                }}
                className="text-xs px-2 py-0.5 rounded text-primary-text hover:bg-primary-bg transition-colors"
              >
                Reopen
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(comment.id);
              }}
              className="text-xs px-2 py-0.5 rounded text-danger hover:bg-danger-bg transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Replies thread */}
      {replies.length > 0 && (
        <div className="mx-3 mb-2 border-l-2 border-border pl-3 space-y-2">
          {replies.map((reply) => (
            <div key={reply.id} className="text-xs">
              <p className="text-content-secondary leading-relaxed">{reply.text}</p>
              <span className="text-content-muted">
                {reply.author} &middot; {getTimeAgo(reply.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Reply input */}
      {!isResolved && (
        <div className="px-3 pb-3" onClick={(e) => e.stopPropagation()}>
          {isReplying ? (
            <div>
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
                    setIsReplying(false);
                  }
                }}
                placeholder="Write a reply..."
                className="w-full text-xs border border-border rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content"
                rows={2}
              />
              <div className="flex justify-end gap-1.5 mt-1">
                <button
                  onClick={() => {
                    setReplyText('');
                    setIsReplying(false);
                  }}
                  className="text-xs px-2 py-0.5 rounded text-content-secondary hover:bg-surface-inset transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReplySubmit}
                  disabled={!replyText.trim()}
                  className="text-xs px-2 py-0.5 rounded bg-primary text-on-primary hover:bg-primary-hover transition-colors disabled:opacity-40"
                >
                  Reply
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsReplying(true)}
              className="text-xs text-content-muted hover:text-primary-text transition-colors"
            >
              Reply
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
