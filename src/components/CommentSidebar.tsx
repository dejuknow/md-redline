import { useRef, useEffect } from 'react';
import type { MdComment } from '../types';
import { CommentCard } from './CommentCard';

interface Props {
  comments: MdComment[];
  activeCommentId: string | null;
  onActivate: (id: string) => void;
  onResolve: (id: string) => void;
  onUnresolve: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CommentSidebar({
  comments,
  activeCommentId,
  onActivate,
  onResolve,
  onUnresolve,
  onDelete,
}: Props) {
  const activeRef = useRef<HTMLDivElement>(null);

  const activeComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);

  // Scroll to active comment
  useEffect(() => {
    if (activeCommentId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCommentId]);

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 px-6">
        <svg
          className="w-12 h-12 mb-3 text-slate-300"
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
        <p className="text-sm font-medium text-slate-500 mb-1">No comments yet</p>
        <p className="text-xs text-center leading-relaxed">
          Select text in the document to add your first comment
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {activeComments.map((comment) => (
          <div
            key={comment.id}
            ref={comment.id === activeCommentId ? activeRef : undefined}
          >
            <CommentCard
              comment={comment}
              isActive={comment.id === activeCommentId}
              onActivate={onActivate}
              onResolve={onResolve}
              onUnresolve={onUnresolve}
              onDelete={onDelete}
            />
          </div>
        ))}

        {resolvedComments.length > 0 && (
          <>
            <div className="flex items-center gap-2 pt-3 pb-1">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400 font-medium">
                Resolved ({resolvedComments.length})
              </span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            {resolvedComments.map((comment) => (
              <div
                key={comment.id}
                ref={comment.id === activeCommentId ? activeRef : undefined}
              >
                <CommentCard
                  comment={comment}
                  isActive={comment.id === activeCommentId}
                  onActivate={onActivate}
                  onResolve={onResolve}
                  onUnresolve={onUnresolve}
                  onDelete={onDelete}
                />
              </div>
            ))}
          </>
        )}
      </div>

      {/* Summary */}
      <div className="border-t border-slate-200 px-4 py-2 bg-slate-50/50">
        <span className="text-xs text-slate-500">
          {activeComments.length} open
          {resolvedComments.length > 0 &&
            ` · ${resolvedComments.length} resolved`}
        </span>
      </div>
    </div>
  );
}
