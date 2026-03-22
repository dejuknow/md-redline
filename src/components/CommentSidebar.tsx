import { useState, useRef, useEffect } from 'react';
import type { MdComment, CommentStatus } from '../types';
import { getEffectiveStatus } from '../types';
import { CommentCard } from './CommentCard';
import type { FilterMode } from '../hooks/useSessionPersistence';

interface Props {
  comments: MdComment[];
  activeCommentId: string | null;
  missingAnchors: Set<string>;
  filter: FilterMode;
  onFilterChange: (filter: FilterMode) => void;
  onActivate: (id: string) => void;
  onSetStatus: (id: string, status: CommentStatus) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReply: (id: string, text: string) => void;
  onBulkResolve: () => void;
  onBulkDeleteResolved: () => void;
}

const FILTER_TABS: { key: FilterMode; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'addressed', label: 'Addressed' },
  { key: 'accepted', label: 'Accepted' },
];

export function CommentSidebar({
  comments,
  activeCommentId,
  missingAnchors,
  filter,
  onFilterChange,
  onActivate,
  onSetStatus,
  onDelete,
  onEdit,
  onReply,
  onBulkResolve,
  onBulkDeleteResolved,
}: Props) {
  const activeRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // Scroll to active comment
  useEffect(() => {
    if (activeCommentId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCommentId]);

  // Count by status
  const counts = { open: 0, addressed: 0, accepted: 0, reopened: 0 };
  for (const c of comments) {
    counts[getEffectiveStatus(c)]++;
  }
  const openCount = counts.open + counts.reopened;
  const addressedCount = counts.addressed;
  const acceptedCount = counts.accepted;

  // Filter and search
  const filtered = comments.filter((c) => {
    const status = getEffectiveStatus(c);

    // Status filter
    if (filter === 'open' && status !== 'open' && status !== 'reopened') return false;
    if (filter === 'addressed' && status !== 'addressed') return false;
    if (filter === 'accepted' && status !== 'accepted') return false;

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

  // Sort: active (non-accepted) first, then accepted
  const activeComments = filtered.filter((c) => getEffectiveStatus(c) !== 'accepted');
  const resolvedComments = filtered.filter((c) => getEffectiveStatus(c) === 'accepted');

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
      {/* Filter tabs */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex gap-1">
          {FILTER_TABS.map(({ key, label }) => {
            const count =
              key === 'all'
                ? comments.length
                : key === 'open'
                  ? openCount
                  : key === 'addressed'
                    ? addressedCount
                    : acceptedCount;
            return (
              <button
                key={key}
                onClick={() => onFilterChange(key)}
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

      {/* Search */}
      <div className="px-3 pb-2">
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
              onSetStatus={onSetStatus}
              onDelete={onDelete}
              onEdit={onEdit}
              onReply={onReply}
            />
          </div>
        ))}

        {resolvedComments.length > 0 && filter !== 'accepted' && (
          <div className="flex items-center gap-2 pt-3 pb-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-content-muted font-medium">
              Accepted ({resolvedComments.length})
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
              onSetStatus={onSetStatus}
              onDelete={onDelete}
              onEdit={onEdit}
              onReply={onReply}
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
            {openCount} open
            {addressedCount > 0 && ` \u00b7 ${addressedCount} addressed`}
            {acceptedCount > 0 && ` \u00b7 ${acceptedCount} accepted`}
          </span>
          <div className="flex gap-1">
            {openCount + addressedCount > 0 && (
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
            {acceptedCount > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onBulkDeleteResolved();
                }}
                className="text-[10px] px-2 py-0.5 rounded text-danger hover:bg-danger-bg font-medium transition-colors"
                title="Delete all accepted comments"
              >
                Clear Accepted
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
