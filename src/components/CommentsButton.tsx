import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useDismiss } from '../hooks/useDismiss';
import type { RailDensity } from '../hooks/usePaneLayout';

export interface CommentsButtonProps {
  /** Whether a comments surface (rail or drawer) is on screen. */
  surfaceVisible: boolean;
  /** Shown on the toggle, which also carries the rail's "N open". */
  openCount: number;
  toggleLabel: string;
  onToggle: () => void;
  /** Null where the rail cannot show (the drawer takes its place): no layout choice then. */
  density: RailDensity | null;
  onDensityChange: (d: RailDensity) => void;
  resolvedCount: number;
  totalCount: number;
  resolveEnabled: boolean;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onBulkResolve?: () => void;
  onBulkDeleteResolved?: () => void;
  onBulkDelete: () => void;
  /**
   * The file the comments belong to. A switch to another file closes the
   * delete-all confirmation, which would otherwise delete the new file's
   * comments on confirm (a tab switch by keyboard leaves it open).
   */
  filePath?: string | null;
}

const menuItemClass =
  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-content transition-colors hover:bg-tint disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

/**
 * The comments toggle as a split button. The bubble shows or hides the rail
 * (or, where the rail does not fit, the drawer) and carries the open count;
 * the chevron opens the rail's options: Anchored or List, previous and next
 * comment, and the bulk actions. The options live in the toggle's own menu so
 * they sit with the comments and leave the strip's width to the tabs.
 */
export function CommentsButton({
  surfaceVisible,
  openCount,
  toggleLabel,
  onToggle,
  density,
  onDensityChange,
  resolvedCount,
  totalCount,
  resolveEnabled,
  onJumpPrev,
  onJumpNext,
  onBulkResolve,
  onBulkDeleteResolved,
  onBulkDelete,
  filePath,
}: CommentsButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, ref, close);

  // The comments can go away without any click of ours (a file-watcher reload,
  // an agent rewriting the document), so the delete-all dialog would ask about
  // comments that are already gone.
  useEffect(() => {
    if (totalCount === 0) setConfirmDeleteAll(false);
  }, [totalCount]);
  useEffect(() => {
    setConfirmDeleteAll(false);
  }, [filePath]);

  const pick = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const canResolveAll = resolveEnabled && openCount > 0 && !!onBulkResolve;
  // Either mode: a file can carry resolved markers with the workflow off.
  const canClearResolved = resolvedCount > 0 && !!onBulkDeleteResolved;

  return (
    <div ref={ref} className="relative flex items-center">
      <div
        data-comments-button
        className={`h-7 flex items-center rounded-md transition-colors ${
          surfaceVisible ? 'bg-tint text-content' : 'text-content-muted'
        }`}
      >
        {/* No Tooltip wrapper: the title is the e2e and screen-reader handle,
            and a Tooltip stashes it while hovered. */}
        <button
          type="button"
          className={`h-7 min-w-[40px] pl-2 pr-1.5 flex items-center justify-center gap-1.5 rounded-l-md text-[13px] font-medium transition-colors ${
            surfaceVisible ? '' : 'hover:text-content hover:bg-tint'
          }`}
          onClick={onToggle}
          aria-label={toggleLabel}
          aria-pressed={surfaceVisible}
          title={toggleLabel}
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.3}
          >
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
          </svg>
          {openCount > 0 && <span className="tabular-nums">{openCount}</span>}
        </button>
        <span className="w-px h-4 bg-border" aria-hidden="true" />
        <button
          type="button"
          data-rail-actions
          className={`h-7 w-6 flex items-center justify-center rounded-r-md transition-colors ${
            menuOpen ? 'bg-tint text-content' : 'hover:text-content hover:bg-tint'
          }`}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Comment options"
          title="Comment options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <svg
            className="w-3 h-3"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
          >
            <path d="M3.5 5.5L7 9l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Comment options"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-surface shadow-lg py-1"
        >
          {density && (
            <>
              <div className="px-3 pt-1 pb-0.5 text-[11px] font-medium text-content-muted">
                Layout
              </div>
              {(['anchored', 'list'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  role="menuitemradio"
                  aria-checked={density === d}
                  data-rail-density={d}
                  className={menuItemClass}
                  onClick={pick(() => onDensityChange(d))}
                >
                  <span className="flex-1">{d === 'anchored' ? 'Anchored' : 'List'}</span>
                  {density === d && <span aria-hidden="true">&#10003;</span>}
                </button>
              ))}
              <div className="my-1 h-px bg-border-subtle" aria-hidden="true" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            data-rail-prev
            disabled={totalCount === 0}
            className={menuItemClass}
            onClick={pick(onJumpPrev)}
          >
            <span className="flex-1">Previous comment</span>
            <kbd className="text-[12px] text-content-muted font-sans">P</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            data-rail-next
            disabled={totalCount === 0}
            className={menuItemClass}
            onClick={pick(onJumpNext)}
          >
            <span className="flex-1">Next comment</span>
            <kbd className="text-[12px] text-content-muted font-sans">N</kbd>
          </button>
          {totalCount > 0 && (
            <>
              <div className="my-1 h-px bg-border-subtle" aria-hidden="true" />
              {canResolveAll && (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={pick(onBulkResolve!)}
                >
                  Resolve all open
                </button>
              )}
              {canClearResolved && (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={pick(onBulkDeleteResolved!)}
                >
                  Clear resolved
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={`${menuItemClass} text-danger`}
                onClick={pick(() => setConfirmDeleteAll(true))}
              >
                Delete all comments&hellip;
              </button>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all comments"
        message="This will permanently delete all comments. This cannot be undone."
        confirmLabel="Delete All"
        onConfirm={() => {
          setConfirmDeleteAll(false);
          onBulkDelete();
        }}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </div>
  );
}
