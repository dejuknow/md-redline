import { useEffect } from 'react';
import type { ComponentProps } from 'react';
import { CommentListSurface } from './CommentListSurface';

type ListSurfaceProps = ComponentProps<typeof CommentListSurface>;

interface Props extends ListSurfaceProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side drawer hosting the shared comment list surface. This is the
 * comments access point wherever the rail cannot exist: raw view, diff
 * mode, or a rendered view too narrow to fit the rail (see `railShown` in
 * App.tsx). Opened via the FAB or the Cmd+\ fallback.
 */
export function CommentsDrawer({ open, onClose, ...listProps }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" data-comments-drawer>
      <div
        className="absolute inset-0 bg-black/20 overlay-backdrop-enter"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Comments"
        className="absolute inset-y-0 right-0 w-[340px] max-w-[90vw] bg-surface border-l border-border shadow-xl flex flex-col overlay-panel-enter"
      >
        <div className="h-10 flex items-center justify-between pl-3 pr-2 shrink-0 border-b border-border-subtle">
          <h2 className="text-xs font-medium text-content">Comments</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Close comments drawer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <CommentListSurface {...listProps} />
        </div>
      </aside>
    </div>
  );
}
