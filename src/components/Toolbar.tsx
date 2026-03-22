import { ThemeSelector } from './ThemeSelector';

export type ViewMode = 'rendered' | 'raw' | 'diff';

interface Props {
  filePath: string;
  lastSaved: Date | null;
  error: string | null;
  isLoading: boolean;
  commentCount: number;
  viewMode: ViewMode;
  hasSnapshot: boolean;
  hasExternalChange: boolean;
  showReviewSummary: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onReload: () => void;
  onSnapshot: () => void;
  onJumpToNext: () => void;
  onToggleReviewSummary: () => void;
}

export function Toolbar({
  filePath,
  lastSaved,
  error,
  isLoading,
  commentCount,
  viewMode,
  hasSnapshot,
  hasExternalChange,
  showReviewSummary,
  onViewModeChange,
  onReload,
  onSnapshot,
  onJumpToNext,
  onToggleReviewSummary,
}: Props) {
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="h-12 border-b border-border bg-surface flex items-center px-4 gap-3 shrink-0">
      {/* App logo */}
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-primary-text" viewBox="0 0 32 32" fill="none">
          <rect
            x="4"
            y="2"
            width="18"
            height="24"
            rx="2"
            fill="currentColor"
            opacity="0.15"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line
            x1="8"
            y1="8"
            x2="18"
            y2="8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="12"
            x2="16"
            y2="12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="16"
            x2="18"
            y2="16"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M18 18h8a2 2 0 012 2v6a2 2 0 01-2 2h-4l-3 3v-3h-1a2 2 0 01-2-2v-6a2 2 0 012-2z"
            style={{ fill: 'var(--theme-comment-underline)', stroke: 'var(--theme-comment-underline-active)' }}
            strokeWidth="1"
          />
        </svg>
        <span className="text-sm font-semibold text-content">md-commenter</span>
      </div>

      {/* Separator */}
      <div className="h-5 w-px bg-border" />

      {/* File info */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-sm text-content-secondary truncate font-medium" title={filePath}>
          {fileName}
        </span>
        {commentCount > 0 && (
          <span className="text-xs bg-primary-bg-strong text-primary-text px-1.5 py-0.5 rounded-full font-medium">
            {commentCount}
          </span>
        )}
        {hasExternalChange && (
          <span className="text-xs bg-status-addressed-bg text-status-addressed-text px-1.5 py-0.5 rounded-full font-medium animate-pulse">
            External change
          </span>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-danger font-medium">{error}</span>}
        {isLoading && <span className="text-xs text-content-muted">Loading...</span>}
        {lastSaved && !error && !isLoading && (
          <span className="text-xs text-content-muted">Saved {lastSaved.toLocaleTimeString()}</span>
        )}

        {/* Jump to next unresolved */}
        {commentCount > 0 && (
          <button
            onClick={onJumpToNext}
            className="text-content-muted hover:text-primary-text transition-colors p-1 rounded hover:bg-primary-bg"
            title="Jump to next unresolved comment (N)"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12"
              />
            </svg>
          </button>
        )}

        {/* Review summary */}
        <button
          onClick={onToggleReviewSummary}
          className={`p-1 rounded transition-colors ${
            showReviewSummary
              ? 'text-primary-text bg-primary-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title="Review summary across files"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"
            />
          </svg>
        </button>

        {/* Snapshot for diff */}
        <button
          onClick={onSnapshot}
          className={`p-1 rounded transition-colors ${
            hasSnapshot
              ? 'text-success-text hover:text-success hover:bg-success-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title={hasSnapshot ? 'Update diff snapshot' : 'Take diff snapshot'}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
            />
          </svg>
        </button>

        {/* Diff view toggle */}
        {hasSnapshot && (
          <button
            onClick={() => onViewModeChange(viewMode === 'diff' ? 'rendered' : 'diff')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'diff'
                ? 'text-primary-text bg-primary-bg'
                : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
            }`}
            title={viewMode === 'diff' ? 'Switch to rendered view' : 'View diff since snapshot'}
          >
            <svg
              className="w-4 h-4"
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
          </button>
        )}

        {/* Raw markdown toggle */}
        <button
          onClick={() => onViewModeChange(viewMode === 'raw' ? 'rendered' : 'raw')}
          className={`p-1 rounded transition-colors ${
            viewMode === 'raw'
              ? 'text-primary-text bg-primary-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title={viewMode === 'raw' ? 'Switch to rendered view' : 'View raw markdown'}
        >
          <svg
            className="w-4 h-4"
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

        {/* Theme selector */}
        <ThemeSelector />

        {/* Reload button */}
        <button
          onClick={onReload}
          className="text-content-muted hover:text-content-secondary transition-colors p-1 rounded hover:bg-surface-inset"
          title="Reload file"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
