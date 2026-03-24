import { useState, useRef, useEffect } from 'react';
import type { MdComment } from '../types';
import { CommentCard } from './CommentCard';

export interface SidebarContextMenuInfo {
  commentId: string;
  x: number;
  y: number;
}

interface Props {
  comments: MdComment[];
  activeCommentId: string | null;
  missingAnchors: Set<string>;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReply: (id: string, text: string) => void;
  onBulkDelete: () => void;
  onContextMenu?: (info: SidebarContextMenuInfo) => void;
  /** When set, the matching comment enters edit mode. Use Date.now() to re-trigger. */
  requestEditId?: string | null;
  requestEditToken?: number;
  /** When set, the matching comment enters reply mode. Use Date.now() to re-trigger. */
  requestReplyId?: string | null;
  requestReplyToken?: number;
}

export function CommentSidebar({
  comments,
  activeCommentId,
  missingAnchors,
  onActivate,
  onDelete,
  onEdit,
  onReply,
  onBulkDelete,
  onContextMenu: onCtxMenu,
  requestEditId,
  requestEditToken,
  requestReplyId,
  requestReplyToken,
}: Props) {
  const activeRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // Scroll to active comment
  useEffect(() => {
    if (activeCommentId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCommentId]);

  // Search filter
  const filtered = comments.filter((c) => {
    if (search) {
      const q = search.toLowerCase();
      const matchesText = c.text.toLowerCase().includes(q);
      const matchesAnchor = c.anchor.toLowerCase().includes(q);
      const matchesAuthor = c.author.toLowerCase().includes(q);
      const matchesReply = c.replies?.some((r) => r.text.toLowerCase().includes(q)) ?? false;
      if (!matchesText && !matchesAnchor && !matchesAuthor && !matchesReply) return false;
    }

    return true;
  });

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-content-muted px-6">
        <svg
          className="w-12 h-12 mb-3 text-content-faint"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
        <p className="text-sm font-medium text-content-secondary mb-1">No comments yet</p>
        <p className="text-xs text-center leading-relaxed">
          Select text in the document to add your first comment
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search comments..."
          className="w-full text-xs border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content"
        />
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {filtered.map((comment) => (
          <div key={comment.id} ref={comment.id === activeCommentId ? activeRef : undefined}>
            <CommentCard
              comment={comment}
              isActive={comment.id === activeCommentId}
              anchorMissing={missingAnchors.has(comment.id)}
              onActivate={onActivate}
              onDelete={onDelete}
              onEdit={onEdit}
              onReply={onReply}
              onContextMenu={onCtxMenu ? (id, x, y) => onCtxMenu({ commentId: id, x, y }) : undefined}
              requestEdit={comment.id === requestEditId ? requestEditToken : undefined}
              requestReply={comment.id === requestReplyId ? requestReplyToken : undefined}
            />
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="text-center py-6">
            <p className="text-xs text-content-muted">
              {search ? 'No comments match your search' : 'No comments'}
            </p>
          </div>
        )}
      </div>

      {/* Footer: summary + bulk actions */}
      <div className="border-t border-border px-4 py-2 bg-surface-secondary">
        <div className="flex items-center justify-between">
          <span className="text-xs text-content-secondary">
            {comments.length} comment{comments.length !== 1 ? 's' : ''}
          </span>
          <div className="flex gap-1">
            {comments.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onBulkDelete();
                }}
                className="text-[10px] px-2 py-0.5 rounded text-danger hover:bg-danger-bg font-medium transition-colors"
                title="Delete all comments"
              >
                Delete All
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
