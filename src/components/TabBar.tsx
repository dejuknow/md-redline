import type { ViewMode } from './Toolbar';

interface Tab {
  filePath: string;
  error: string | null;
}

export interface TabContextMenuInfo {
  filePath: string;
  x: number;
  y: number;
}

interface Props {
  tabs: Tab[];
  activeFilePath: string | null;
  commentCounts: Map<string, number>;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onOpenFile: () => void;
  onTabContextMenu?: (info: TabContextMenuInfo) => void;
  // Document actions (moved from Toolbar)
  viewMode: ViewMode;
  hasSnapshot: boolean;
  hasExternalChange: boolean;
  showReviewSummary: boolean;
  commentCount: number;
  onViewModeChange: (mode: ViewMode) => void;
  onSnapshot: () => void;
  onJumpToNext: () => void;
  onToggleReviewSummary: () => void;
  onReload: () => void;
}

export function TabBar({
  tabs,
  activeFilePath,
  commentCounts,
  onSwitchTab,
  onCloseTab,
  onOpenFile,
  onTabContextMenu,
  viewMode,
  hasSnapshot,
  hasExternalChange,
  showReviewSummary,
  commentCount,
  onViewModeChange,
  onSnapshot,
  onJumpToNext,
  onToggleReviewSummary,
  onReload,
}: Props) {
  return (
    <div className="h-9 bg-surface-secondary border-b border-border flex items-stretch shrink-0">
      {/* Tabs (scrollable) */}
      <div className="flex items-stretch overflow-x-auto min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.filePath === activeFilePath;
          const fileName = tab.filePath.split('/').pop() || tab.filePath;
          const count = commentCounts.get(tab.filePath) ?? 0;
          return (
            <button
              key={tab.filePath}
              onClick={() => onSwitchTab(tab.filePath)}
              onContextMenu={(e) => {
                if (onTabContextMenu) {
                  e.preventDefault();
                  onTabContextMenu({ filePath: tab.filePath, x: e.clientX, y: e.clientY });
                }
              }}
              className={`group flex items-center gap-1.5 px-3 text-xs border-r border-border shrink-0 max-w-[200px] transition-colors ${
                isActive
                  ? 'bg-surface text-content font-medium border-b-2 border-b-primary'
                  : 'text-content-secondary hover:text-content hover:bg-surface-inset'
              }`}
              title={tab.filePath}
            >
              <span className="truncate">{fileName}</span>
              {count > 0 && (
                <span
                  className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                    isActive ? 'bg-primary-bg-strong text-primary-text' : 'bg-surface-inset text-content-secondary'
                  }`}
                >
                  {count}
                </span>
              )}
              {tab.error && <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.filePath);
                }}
                className={`ml-1 p-0.5 rounded hover:bg-surface-inset shrink-0 transition-opacity ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <svg
                  className="w-3 h-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            </button>
          );
        })}
        <button
          onClick={onOpenFile}
          className="px-2.5 text-content-muted hover:text-content-secondary hover:bg-surface-inset transition-colors shrink-0"
          title="Open file"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Document actions (right side) */}
      <div className="flex items-center gap-0.5 px-2 shrink-0">
        {/* Comment navigation group */}
        {commentCount > 0 && (
          <button
            onClick={onJumpToNext}
            className="text-content-muted hover:text-primary-text transition-colors p-1 rounded hover:bg-primary-bg"
            title="Jump to next unresolved comment (N)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12"
              />
            </svg>
          </button>
        )}
        <button
          onClick={onToggleReviewSummary}
          className={`p-1 rounded transition-colors ${
            showReviewSummary
              ? 'text-primary-text bg-primary-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title="Review summary across files"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"
            />
          </svg>
        </button>

        {/* Separator */}
        <div className="h-4 w-px bg-border mx-1" />

        {/* View controls group */}
        <button
          onClick={() => onViewModeChange(viewMode === 'raw' ? 'rendered' : 'raw')}
          className={`p-1 rounded transition-colors ${
            viewMode === 'raw'
              ? 'text-primary-text bg-primary-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title={viewMode === 'raw' ? 'Switch to rendered view' : 'View raw markdown'}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
            />
          </svg>
        </button>
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
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
              />
            </svg>
          </button>
        )}
        <button
          onClick={onSnapshot}
          className={`p-1 rounded transition-colors ${
            hasSnapshot
              ? 'text-success-text hover:text-success hover:bg-success-bg'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title={hasSnapshot ? 'Update diff snapshot' : 'Take diff snapshot'}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
          </svg>
        </button>

        {/* Separator */}
        <div className="h-4 w-px bg-border mx-1" />

        {/* File actions */}
        {hasExternalChange && (
          <span className="text-[10px] bg-warning-bg text-warning-text px-1.5 py-0.5 rounded-full font-medium animate-pulse mr-1">
            Changed
          </span>
        )}
        <button
          onClick={onReload}
          className="text-content-muted hover:text-content-secondary transition-colors p-1 rounded hover:bg-surface-inset"
          title="Reload file"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
