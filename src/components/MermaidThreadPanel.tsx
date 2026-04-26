import type { MdComment } from '../types';
import { ThreadCard } from './ThreadCard';

export interface MermaidThreadPanelProps {
  threads: MdComment[];
  activeCommentId: string | null;
  onSelectThread: (id: string) => void;
  onReply: (commentId: string, text: string) => void;
  onResolve?: (commentId: string) => void;
  onUnresolve?: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, newText: string) => void;
  onEditReply: (commentId: string, replyId: string, newText: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
}

/**
 * Comment panel for the Mermaid fullscreen modal. Visual chrome (surface
 * background, border, header layout, comments-icon glyph) mirrors
 * `CommentSidebar` so the two views feel like the same product. The modal
 * owns the resize handle + width animation; this component just renders the
 * inner column.
 */
export function MermaidThreadPanel(props: MermaidThreadPanelProps) {
  const empty = props.threads.length === 0;

  return (
    <aside className="h-full flex flex-col min-w-0" aria-label="Diagram comments">
      <header className="h-10 flex items-center pl-1 pr-2 shrink-0">
        <h2 className="px-2.5 py-1.5 rounded text-xs font-medium text-content flex items-center gap-1">
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
            />
          </svg>
          Comments
          <span className="text-[10px] text-content-muted ml-1">({props.threads.length})</span>
        </h2>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {empty && (
          <div className="flex flex-col items-center justify-center h-full text-content-muted px-6 py-10">
            <p className="text-sm font-medium text-content-secondary mb-1">No comments yet</p>
            <p className="text-xs text-center leading-relaxed">
              Select text on any node to add a comment.
            </p>
          </div>
        )}

        {props.threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            active={thread.id === props.activeCommentId}
            onSelect={props.onSelectThread}
            onReply={props.onReply}
            onResolve={props.onResolve}
            onUnresolve={props.onUnresolve}
            onDelete={props.onDelete}
            onEdit={props.onEdit}
            onEditReply={props.onEditReply}
            onDeleteReply={props.onDeleteReply}
          />
        ))}
      </div>
    </aside>
  );
}
