import type { MdComment } from '../types';

interface Props {
  comment: MdComment;
  isActive: boolean;
  onActivate: (id: string) => void;
  onResolve: (id: string) => void;
  onUnresolve: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CommentCard({
  comment,
  isActive,
  onActivate,
  onResolve,
  onUnresolve,
  onDelete,
}: Props) {
  const timeAgo = getTimeAgo(comment.timestamp);

  return (
    <div
      className={`group rounded-lg border transition-all duration-200 cursor-pointer ${
        isActive
          ? 'border-indigo-300 bg-indigo-50/50 shadow-sm ring-1 ring-indigo-200'
          : comment.resolved
            ? 'border-slate-200 bg-slate-50/50 opacity-60'
            : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
      }`}
      onClick={() => onActivate(comment.id)}
    >
      {/* Anchor text preview */}
      <div className="px-3 pt-3 pb-1">
        <div
          className={`text-xs font-mono px-2 py-1 rounded inline-block max-w-full truncate ${
            comment.resolved
              ? 'bg-slate-100 text-slate-400'
              : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}
        >
          &ldquo;{comment.anchor}&rdquo;
        </div>
      </div>

      {/* Comment text */}
      <div className="px-3 py-2">
        <p
          className={`text-sm leading-relaxed ${
            comment.resolved ? 'text-slate-400 line-through' : 'text-slate-700'
          }`}
        >
          {comment.text}
        </p>
      </div>

      {/* Footer */}
      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-xs text-slate-400">
          {comment.author} &middot; {timeAgo}
        </span>

        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {comment.resolved ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnresolve(comment.id);
              }}
              className="text-xs px-2 py-0.5 rounded text-indigo-600 hover:bg-indigo-50 transition-colors"
            >
              Reopen
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onResolve(comment.id);
              }}
              className="text-xs px-2 py-0.5 rounded text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              Resolve
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(comment.id);
            }}
            className="text-xs px-2 py-0.5 rounded text-red-500 hover:bg-red-50 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

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
