import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';
import { useElementNarrowerThan } from '../hooks/useElementNarrowerThan';
import { useDismiss } from '../hooks/useDismiss';
import { getPrimaryModifierLabel } from '../lib/platform';
import type { ViewMode } from '../lib/view-mode';

export interface DocStripProps {
  /** The tab bar, rendered in its strip look. */
  tabs: React.ReactNode;
  /** Rail controls (prev/next, density, "N open", bulk actions). App passes
   * them only while the rail is shown, so their presence is also what tells
   * the comments toggle to drop its own count. */
  railControls?: React.ReactNode;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  hasDiffSnapshot: boolean;
  diffEnabled: boolean;
  diffPending?: boolean;
  diffChunkCount: number;
  onDiffToggle: () => void;
  searchActive: boolean;
  onSearch: () => void;
  /** `announce` asks App to confirm with a toast: the View menu closes on
   * the click, so the copy item's own checkmark is never seen. */
  onCopyDocument: (announce?: boolean) => void;
  copyFeedback: boolean;
  /** Whether a comments surface (rail or drawer) is on screen. */
  commentsSurfaceVisible: boolean;
  openCommentCount: number;
  onToggleComments: () => void;
}

/** Under this strip width, view, diff and copy fold into the View menu. */
const NARROW_STRIP_WIDTH = 600;

const iconButtonClass = (pressed: boolean) =>
  `h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
    pressed ? 'bg-tint text-content' : 'text-content-muted hover:text-content hover:bg-tint'
  }`;

const segmentClass = (on: boolean) =>
  `h-6 w-7 flex items-center justify-center rounded transition-colors ${
    on ? 'bg-surface text-content shadow-sm' : 'text-content-muted hover:text-content'
  }`;

const menuItemClass =
  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-content transition-colors hover:bg-tint disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

function RenderedIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
    >
      <path d="M4 2h5.5L12 4.5V14H4z" strokeLinejoin="round" />
      <path d="M6 7.5h4M6 10h4" strokeLinecap="round" />
    </svg>
  );
}

function RawIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
    >
      <path
        d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DiffIcon() {
  return (
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
        d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
      />
    </svg>
  );
}

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  ) : (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
      />
    </svg>
  );
}

/**
 * The document panel's top row: the open tabs on the left, attached to the
 * page below like folder tabs, and the document's controls on the right
 * (view mode, diff, search, copy, then the comments toggle).
 * The tabs scroll in their own region, so the controls never cover a tab.
 *
 * Every control keeps the title, aria-label and test id it had in the old
 * panel toolbar and title row; e2e specs and screen readers find them by
 * those. When the strip gets narrow, view, diff and copy fold into a View
 * menu while search and the comments toggle stay out.
 */
export function DocStrip({
  tabs,
  railControls,
  viewMode,
  onViewModeChange,
  hasDiffSnapshot,
  diffEnabled,
  diffPending,
  diffChunkCount,
  onDiffToggle,
  searchActive,
  onSearch,
  onCopyDocument,
  copyFeedback,
  commentsSurfaceVisible,
  openCommentCount,
  onToggleComments,
}: DocStripProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Not measured yet counts as wide: render the wide layout until we know better.
  const narrow = useElementNarrowerThan(rootRef, NARROW_STRIP_WIDTH);

  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!narrow) setViewMenuOpen(false);
  }, [narrow]);

  // Closes on a press or focus outside, and on Escape unless another overlay
  // (the command palette, a dialog) is open and owns it. The selection's
  // Escape, which runs first, already counts an open menu as owning the key
  // and leaves the selection and any draft alone.
  const closeViewMenu = useCallback(() => setViewMenuOpen(false), []);
  useDismiss(viewMenuOpen, viewMenuRef, closeViewMenu);

  const modLabel = getPrimaryModifierLabel();
  const isRaw = viewMode === 'raw';

  // The button that changes the view carries the action-shaped title the old
  // single toggle had ("View raw markdown" / "Switch to rendered view"); the
  // segment already showing names the current view instead.
  const renderedLabel = isRaw ? 'Switch to rendered view' : 'Rendered view';
  const rawLabel = isRaw ? 'Raw markdown' : 'View raw markdown';
  const diffLabel = !hasDiffSnapshot
    ? 'Show diff. Available after a handoff, or once an agent saves a copy before editing.'
    : diffEnabled
      ? 'Hide diff'
      : 'Show diff';
  const searchLabel = `Find in document (${modLabel}+F)`;
  const copyLabel = copyFeedback ? 'Copied!' : 'Copy document (comment markers stripped)';
  const commentsLabel = `Toggle comments rail (${modLabel}+\\)`;
  // With zero changes the overlay has nothing to paint, so the toggle stays
  // visually quiet even while it is on; aria-pressed still reports the state.
  const diffShowingChanges = diffEnabled && diffChunkCount > 0;
  // The rail controls already say "N open"; repeat the count only without them.
  const showCommentCount = !railControls && openCommentCount > 0;

  const setView = (mode: ViewMode) => {
    if (mode !== viewMode) onViewModeChange(mode);
  };

  const diffCount = diffChunkCount > 0 && (
    <span className="text-[12px] tabular-nums">{diffChunkCount}</span>
  );
  const diffPendingDot = diffPending && !diffEnabled && (
    <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-content-secondary animate-pulse" />
  );

  const searchButton = (
    <Tooltip text={searchLabel}>
      <button
        type="button"
        className={iconButtonClass(searchActive)}
        onClick={onSearch}
        aria-label={searchLabel}
        aria-pressed={searchActive}
        title={searchLabel}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  );

  // No Tooltip wrapper: the title is the e2e and screen-reader handle, and a
  // Tooltip stashes it while hovered. The fixed minimum width holds the
  // button's size steady as the count comes and goes with the rail, so the
  // controls to its left do not slide under the pointer on a view switch.
  const commentsButton = (
    <button
      type="button"
      className={`h-7 min-w-[46px] px-1.5 flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors ${
        commentsSurfaceVisible
          ? 'bg-tint text-content'
          : 'text-content-muted hover:text-content hover:bg-tint'
      }`}
      onClick={onToggleComments}
      aria-label={commentsLabel}
      aria-pressed={commentsSurfaceVisible}
      title={commentsLabel}
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
      {showCommentCount && <span className="tabular-nums">{openCommentCount}</span>}
    </button>
  );

  return (
    <div
      ref={rootRef}
      data-doc-strip
      className="h-[42px] flex items-end gap-0.5 px-1.5 bg-surface-secondary border-b border-border rounded-t-[9px] shrink-0"
    >
      <div className="min-w-0 flex-1 self-stretch flex items-end">{tabs}</div>

      <div
        className="self-center flex items-center gap-1.5 shrink-0 pl-2"
        data-testid="panel-toolbar"
      >
        {railControls}

        {narrow ? (
          <div ref={viewMenuRef} className="relative">
            <button
              type="button"
              className={`h-7 pl-2 pr-1.5 flex items-center gap-1 rounded-md text-[13px] font-medium transition-colors ${
                viewMenuOpen
                  ? 'bg-tint text-content'
                  : 'text-content-secondary hover:text-content hover:bg-tint'
              }`}
              onClick={() => setViewMenuOpen((open) => !open)}
              aria-label="View options"
              aria-haspopup="menu"
              aria-expanded={viewMenuOpen}
            >
              View
              <svg
                className="w-3 h-3"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.4}
              >
                <path d="M3.5 5.5L7 9l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {diffPendingDot}
            </button>
            {viewMenuOpen && (
              <div
                role="menu"
                aria-label="View options"
                className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-surface shadow-lg py-1"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!isRaw}
                  className={menuItemClass}
                  onClick={() => {
                    setView('rendered');
                    setViewMenuOpen(false);
                  }}
                  aria-label={renderedLabel}
                  title={renderedLabel}
                >
                  <RenderedIcon />
                  <span className="flex-1">Rendered</span>
                  {!isRaw && <span aria-hidden="true">&#10003;</span>}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isRaw}
                  className={menuItemClass}
                  onClick={() => {
                    setView('raw');
                    setViewMenuOpen(false);
                  }}
                  aria-label={rawLabel}
                  title={rawLabel}
                >
                  <RawIcon />
                  <span className="flex-1">Raw markdown</span>
                  {isRaw && <span aria-hidden="true">&#10003;</span>}
                </button>
                <div className="my-1 h-px bg-border-subtle" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={diffEnabled}
                  disabled={!hasDiffSnapshot}
                  className={`${menuItemClass} relative`}
                  onClick={() => {
                    onDiffToggle();
                    setViewMenuOpen(false);
                  }}
                  aria-label={diffLabel}
                  title={diffLabel}
                >
                  <DiffIcon />
                  <span className="flex-1">Diff</span>
                  {diffCount}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="copy-button"
                  className={menuItemClass}
                  onClick={() => {
                    onCopyDocument(true);
                    setViewMenuOpen(false);
                  }}
                  aria-label="Copy document without comment markers"
                  title={copyLabel}
                >
                  <CopyIcon done={copyFeedback} />
                  <span className="flex-1">Copy document</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div role="group" aria-label="View" className="flex bg-surface-inset rounded-md p-0.5">
              <Tooltip text={renderedLabel}>
                <button
                  type="button"
                  className={segmentClass(!isRaw)}
                  onClick={() => setView('rendered')}
                  aria-label={renderedLabel}
                  aria-pressed={!isRaw}
                  title={renderedLabel}
                >
                  <RenderedIcon />
                </button>
              </Tooltip>
              <Tooltip text={rawLabel}>
                <button
                  type="button"
                  className={segmentClass(isRaw)}
                  onClick={() => setView('raw')}
                  aria-label={rawLabel}
                  aria-pressed={isRaw}
                  title={rawLabel}
                >
                  <RawIcon />
                </button>
              </Tooltip>
            </div>

            {/* Always shown, disabled with an explanatory title until a
                snapshot exists, so the path to the diff is discoverable. */}
            <Tooltip text={diffLabel}>
              <button
                type="button"
                disabled={!hasDiffSnapshot}
                className={`relative h-7 px-2 flex items-center gap-1.5 rounded-md border border-border text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
                  diffShowingChanges
                    ? 'bg-tint text-content'
                    : 'text-content-secondary hover:text-content hover:bg-tint'
                }`}
                onClick={onDiffToggle}
                aria-label={diffLabel}
                aria-pressed={diffEnabled}
                title={diffLabel}
              >
                <DiffIcon />
                Diff
                {diffCount}
                {diffPendingDot}
              </button>
            </Tooltip>

            {searchButton}

            {/* Copies clean markdown: comment markers are agent metadata
                nobody wants on the clipboard. */}
            <Tooltip text={copyLabel}>
              <button
                type="button"
                data-testid="copy-button"
                className={iconButtonClass(false)}
                onClick={() => onCopyDocument()}
                aria-label="Copy document without comment markers"
                title={copyLabel}
              >
                <CopyIcon done={copyFeedback} />
              </button>
            </Tooltip>
          </>
        )}

        {narrow && searchButton}
        {commentsButton}
      </div>
    </div>
  );
}
