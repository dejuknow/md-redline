import { useState, useRef, useEffect } from 'react';
import type { MdComment } from '../types';
import { getEffectiveStatus } from '../types';
import { CommentCard } from './CommentCard';
import { useSettings } from '../contexts/SettingsContext';

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
  onResolve?: (id: string) => void;
  onUnresolve?: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReply: (id: string, text: string) => void;
  onBulkDelete: () => void;
  onBulkResolve?: () => void;
  onBulkDeleteResolved?: () => void;
  onContextMenu?: (info: SidebarContextMenuInfo) => void;
  /** When set, the matching comment enters edit mode. Use Date.now() to re-trigger. */
  requestEditId?: string | null;
  requestEditToken?: number;
  /** When set, the matching comment enters reply mode. Use Date.now() to re-trigger. */
  requestReplyId?: string | null;
  requestReplyToken?: number;
}

type FilterMode = 'all' | 'open' | 'resolved';

export function CommentSidebar({
  comments,
  activeCommentId,
  missingAnchors,
  onActivate,
  onResolve,
  onUnresolve,
  onDelete,
  onEdit,
  onReply,
  onBulkDelete,
  onBulkResolve,
  onBulkDeleteResolved,
  onContextMenu: onCtxMenu,
  requestEditId,
  requestEditToken,
  requestReplyId,
  requestReplyToken,
}: Props) {
  const activeRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const { settings } = useSettings();
  const resolveEnabled = settings.enableResolve;

  // Scroll to active comment
  useEffect(() => {
    if (activeCommentId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCommentId]);

  // Count by status (only meaningful when resolve is enabled)
  const openCount = resolveEnabled
    ? comments.filter((c) => getEffectiveStatus(c) === 'open').length
    : comments.length;
  const resolvedCount = resolveEnabled
    ? comments.filter((c) => getEffectiveStatus(c) === 'resolved').length
    : 0;

  // Filter and search
  const filtered = comments.filter((c) => {
    // Status filter (only when resolve enabled)
    if (resolveEnabled) {
      const status = getEffectiveStatus(c);
      if (filter === 'open' && status !== 'open') return false;
      if (filter === 'resolved' && status !== 'resolved') return false;
    }

    // Text search
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

  // Sort: open first, then resolved (only when resolve enabled)
  const activeComments = resolveEnabled
    ? filtered.filter((c) => getEffectiveStatus(c) !== 'resolved')
    : filtered;
  const resolvedComments = resolveEnabled
    ? filtered.filter((c) => getEffectiveStatus(c) === 'resolved')
    : [];

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

  const FILTER_TABS: { key: FilterMode; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'resolved', label: 'Resolved' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Filter tabs (only when resolve enabled) */}
      {resolveEnabled && (
        <div className="px-3 pt-3 pb-1">
          <div className="flex gap-1">
            {FILTER_TABS.map(({ key, label }) => {
              const count =
                key === 'all'
                  ? comments.length
                  : key === 'open'
                    ? openCount
                    : resolvedCount;
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`text-[10px] px-2 py-1 rounded-md font-medium transition-colors ${
                    filter === key
                      ? 'bg-primary-bg-strong text-primary-text'
                      : 'text-content-secondary hover:bg-surface-inset'
                  }`}
                >
                  {label}
                  {count > 0 && (
                    <span className={`ml-1 ${filter === key ? 'text-primary-text' : 'text-content-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Search */}
      <div className={`px-3 ${resolveEnabled ? 'pb-2' : 'pt-3 pb-2'}`}>
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
        {activeComments.map((comment) => (
          <div key={comment.id} ref={comment.id === activeCommentId ? activeRef : undefined}>
            <CommentCard
              comment={comment}
              isActive={comment.id === activeCommentId}
              anchorMissing={missingAnchors.has(comment.id)}
              onActivate={onActivate}
              onResolve={resolveEnabled ? onResolve : undefined}
              onUnresolve={resolveEnabled ? onUnresolve : undefined}
              onDelete={onDelete}
              onEdit={onEdit}
              onReply={onReply}
              onContextMenu={onCtxMenu ? (id, x, y) => onCtxMenu({ commentId: id, x, y }) : undefined}
              requestEdit={comment.id === requestEditId ? requestEditToken : undefined}
              requestReply={comment.id === requestReplyId ? requestReplyToken : undefined}
            />
          </div>
        ))}

        {resolveEnabled && resolvedComments.length > 0 && filter !== 'resolved' && (
          <div className="flex items-center gap-2 pt-3 pb-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-content-muted font-medium">
              Resolved ({resolvedComments.length})
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}
        {resolvedComments.map((comment) => (
          <div key={comment.id} ref={comment.id === activeCommentId ? activeRef : undefined}>
            <CommentCard
              comment={comment}
              isActive={comment.id === activeCommentId}
              anchorMissing={missingAnchors.has(comment.id)}
              onActivate={onActivate}
              onResolve={resolveEnabled ? onResolve : undefined}
              onUnresolve={resolveEnabled ? onUnresolve : undefined}
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
              {search ? 'No comments match your search' : 'No comments in this category'}
            </p>
          </div>
        )}
      </div>

      {/* Footer: summary + bulk actions */}
      <div className="border-t border-border px-4 py-2 bg-surface-secondary">
        <div className="flex items-center justify-between">
          <span className="text-xs text-content-secondary">
            {resolveEnabled ? (
              <>
                {openCount} open
                {resolvedCount > 0 && ` \u00b7 ${resolvedCount} resolved`}
              </>
            ) : (
              <>{comments.length} comment{comments.length !== 1 ? 's' : ''}</>
            )}
          </span>
          <div className="flex gap-1">
            {resolveEnabled ? (
              <>
                {openCount > 0 && onBulkResolve && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onBulkResolve();
                    }}
                    className="text-[10px] px-2 py-0.5 rounded text-success-text hover:bg-success-bg font-medium transition-colors"
                    title="Resolve all open comments"
                  >
                    Resolve All
                  </button>
                )}
                {resolvedCount > 0 && onBulkDeleteResolved && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onBulkDeleteResolved();
                    }}
                    className="text-[10px] px-2 py-0.5 rounded text-danger hover:bg-danger-bg font-medium transition-colors"
                    title="Delete all resolved comments"
                  >
                    Clear Resolved
                  </button>
                )}
              </>
            ) : (
              comments.length > 0 && (
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
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
