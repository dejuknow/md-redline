import { HandOffButton } from './HandOffButton';
import { Tooltip } from './Tooltip';
import { getPrimaryModifierLabel } from '../lib/platform';
import type { ViewMode } from './Toolbar';

interface Props {
  // View mode
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;

  // Search
  searchActive: boolean;
  onSearch: () => void;

  // Handoff
  commentCount: number;
  commentCounts: Map<string, number>;
  activeFilePath: string | null;
  onCopyAgentPrompt?: (filePaths: string[]) => void;

  // Diff
  hasDiffSnapshot: boolean;
  diffEnabled: boolean;
  diffPending?: boolean;
  diffChunkCount: number;
  onDiffToggle: () => void;
  onDiffPrev: () => void;
  onDiffNext: () => void;
  onClearSnapshot: () => void;

  // Copy document (clean markdown, no comment markers — works in both views)
  onCopyDocument: () => void;
  copyFeedback: boolean;
}

const toggleClass = (active: boolean) =>
  `p-1 rounded transition-colors ${
    active
      ? 'text-primary-text bg-primary-bg'
      : 'text-content-muted hover:text-content-secondary hover:bg-tint'
  }`;

const actionClass =
  'text-[11px] rounded px-2 py-0.5 transition-colors text-content-secondary hover:text-content hover:bg-tint';

/**
 * Single panel toolbar shared by raw and rendered views. Hosts every
 * cross-view document action — view mode, diff overlay (+ navigation /
 * clear-snapshot), search, copy, and handoff. Lifting these up here
 * eliminates the previous "two levels of toolbar icons" (TabBar right side
 * + per-view secondary toolbar).
 *
 * Layout:
 *   LEFT  — display state ("how am I looking at this document"):
 *           view mode → diff toggle → prev/next → clear snapshot
 *   RIGHT — actions ("what do I do with this document"):
 *           search → copy → handoff (primary CTA, far right)
 */
export function PanelToolbar({
  viewMode,
  onViewModeChange,
  searchActive,
  onSearch,
  commentCount,
  commentCounts,
  activeFilePath,
  onCopyAgentPrompt,
  hasDiffSnapshot,
  diffEnabled,
  diffPending,
  diffChunkCount,
  onDiffToggle,
  onDiffPrev,
  onDiffNext,
  onClearSnapshot,
  onCopyDocument,
  copyFeedback,
}: Props) {
  const modLabel = getPrimaryModifierLabel();
  const isRaw = viewMode === 'raw';

  // Centralize tooltip strings so each one is declared once and shared
  // between the Tooltip wrapper, the native `title` (kept for accessibility
  // and e2e selectors), and the aria-label.
  const viewModeLabel = isRaw ? 'Switch to rendered view' : 'View raw markdown';
  const diffLabel = !hasDiffSnapshot
    ? 'Show diff overlay — hand off to take a snapshot first'
    : diffEnabled
      ? 'Hide diff overlay'
      : 'Show diff since snapshot';
  const searchLabel = `Find in document (${modLabel}+F)`;
  const copyLabel = copyFeedback ? 'Copied!' : 'Copy document (comment markers stripped)';

  return (
    <div className="raw-toolbar" data-testid="panel-toolbar">
      {/* LEFT: display state — view mode → diff toggle → prev/next → clear */}
      <div className="raw-toolbar-left">
        {/* View mode toggle */}
        <Tooltip text={viewModeLabel}>
          <button
            type="button"
            className={toggleClass(isRaw)}
            onClick={() => onViewModeChange(isRaw ? 'rendered' : 'raw')}
            aria-label={viewModeLabel}
            title={viewModeLabel}
          >
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
                d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
              />
            </svg>
          </button>
        </Tooltip>

        {/* Diff toggle — always visible. Disabled (with explanatory tooltip)
            until a snapshot exists, so users discover the diff feature even
            on a fresh file and learn the path to enable it. */}
        <Tooltip text={diffLabel}>
          <button
            type="button"
            disabled={!hasDiffSnapshot}
            className={`${toggleClass(diffEnabled)} flex items-center gap-1 relative disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
            onClick={onDiffToggle}
            aria-label={diffLabel}
            title={diffLabel}
          >
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
            {diffChunkCount > 0 && (
              <span className="text-[10px] tabular-nums">{diffChunkCount}</span>
            )}
            {diffPending && !diffEnabled && (
              <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-primary animate-pulse" />
            )}
          </button>
        </Tooltip>

        {/* Diff prev/next chevrons */}
        {hasDiffSnapshot && diffEnabled && diffChunkCount > 0 && (
          <div className="flex items-center gap-0.5 ml-1">
            <Tooltip text="Previous change">
              <button
                type="button"
                className="p-0.5 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors"
                onClick={onDiffPrev}
                aria-label="Previous change"
                title="Previous change"
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4.5 15.75l7.5-7.5 7.5 7.5"
                  />
                </svg>
              </button>
            </Tooltip>
            <Tooltip text="Next change">
              <button
                type="button"
                className="p-0.5 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors"
                onClick={onDiffNext}
                aria-label="Next change"
                title="Next change"
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                  />
                </svg>
              </button>
            </Tooltip>
          </div>
        )}

        {/* Clear snapshot */}
        {hasDiffSnapshot && (
          <button
            type="button"
            className={actionClass}
            onClick={onClearSnapshot}
            title="Clear snapshot"
          >
            Clear snapshot
          </button>
        )}
      </div>

      {/* RIGHT: actions — search → copy → handoff (primary CTA, far right) */}
      <div className="raw-toolbar-right">
        {/* Search */}
        <Tooltip text={searchLabel}>
          <button
            type="button"
            className={toggleClass(searchActive)}
            onClick={onSearch}
            aria-label={searchLabel}
            title={searchLabel}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="8" />
              <path strokeLinecap="round" d="m21 21-4.35-4.35" />
            </svg>
          </button>
        </Tooltip>

        {/* Copy clean markdown (no comment markers) — available in both views.
            Markers are agent metadata that nobody wants in the clipboard, so
            "copy" is always equivalent to the old "copy without comments". */}
        <Tooltip text={copyLabel}>
          <button
            type="button"
            data-testid="copy-button"
            className={toggleClass(false)}
            onClick={onCopyDocument}
            aria-label="Copy document without comment markers"
            title={copyLabel}
          >
            {copyFeedback ? (
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
                  d="M4.5 12.75l6 6 9-13.5"
                />
              </svg>
            ) : (
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
                  d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                />
              </svg>
            )}
          </button>
        </Tooltip>

        {/* Handoff (primary CTA — anchors the far right). Always visible
            when a file is open; disabled until at least one comment exists,
            so the path to "send this to an agent" is always discoverable. */}
        {onCopyAgentPrompt && activeFilePath && (
          <HandOffButton
            activeFilePath={activeFilePath}
            commentCounts={commentCounts}
            onCopyAgentPrompt={onCopyAgentPrompt}
            disabled={commentCount === 0}
          />
        )}
      </div>
    </div>
  );
}
