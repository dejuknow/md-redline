import { useState, useRef, useEffect } from 'react';
import type { ViewMode } from './Toolbar';
import { IconButton } from './IconButton';
import { Separator } from './Separator';

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
  commentCount: number;
  enableResolve?: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onSnapshot: () => void;
  onJumpToNext: () => void;
  onSearch: () => void;
  searchActive: boolean;
  onCopyAgentPrompt?: (filePaths: string[]) => void;
}

function HandOffButton({
  activeFilePath,
  commentCounts,
  onCopyAgentPrompt,
}: {
  activeFilePath: string;
  commentCounts: Map<string, number>;
  onCopyAgentPrompt: (filePaths: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chevronHover, setChevronHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // All files with comments
  const filesWithComments = Array.from(commentCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([path, count]) => ({ path, count }));

  const hasMultipleFiles = filesWithComments.length > 1;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset selection when dropdown opens — pre-select all
  useEffect(() => {
    if (open) {
      setSelected(new Set(filesWithComments.map((f) => f.path)));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopySelected = () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    onCopyAgentPrompt(paths);
    setOpen(false);
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <>
      <Separator />
      <div className="group/handoff relative flex items-center" ref={ref} data-testid="handoff-group">
        {/* Paper-plane — hand off active file */}
        <button
          onClick={() => onCopyAgentPrompt([activeFilePath])}
          data-testid="handoff-button"
          className={`transition-[color,background-color,border-radius] duration-150 p-1 ${hasMultipleFiles ? 'rounded-l' : 'rounded'} ${
            chevronHover
              ? 'text-content-secondary bg-surface-inset'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title="Hand off to agent — copy instructions for this file"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
            />
          </svg>
        </button>
        {/* Chevron — always rendered for stable layout; invisible when single file */}
        <button
          onClick={() => hasMultipleFiles && setOpen((p) => !p)}
          onMouseEnter={() => hasMultipleFiles && setChevronHover(true)}
          onMouseLeave={() => setChevronHover(false)}
          data-testid="handoff-chevron"
          className={`pl-0 pr-0.5 self-stretch flex items-center rounded-r transition-[color,background-color,opacity] duration-150 ${
            !hasMultipleFiles
              ? 'opacity-0 pointer-events-none'
              : open
                ? 'text-content-secondary bg-surface-inset'
                : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
          }`}
          title={hasMultipleFiles ? 'Hand off multiple files' : undefined}
          tabIndex={hasMultipleFiles ? 0 : -1}
          aria-hidden={!hasMultipleFiles}
        >
          <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>

        {/* Dropdown */}
        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1.5 min-w-[240px]">
            {filesWithComments.map(({ path, count }) => {
              const isSelected = selected.has(path);
              const isActive = path === activeFilePath;
              return (
                <button
                  key={path}
                  onClick={() => toggle(path)}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-inset transition-colors"
                  title={path}
                >
                  <span className="w-3 h-3 shrink-0 flex items-center justify-center">
                    {isSelected && (
                      <svg className="w-3 h-3 text-primary-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </span>
                  <span className={`text-xs truncate flex-1 text-left ${isActive ? 'text-content font-medium' : 'text-content'}`}>
                    {path.split('/').pop()}
                  </span>
                  <span className="text-[10px] text-content-muted">{count}</span>
                </button>
              );
            })}

            {/* Action button */}
            <div className="border-t border-border mt-1.5 pt-1.5 px-3 pb-1">
              <button
                onClick={handleCopySelected}
                disabled={selected.size === 0}
                className={`w-full text-xs px-2 py-1.5 rounded-md font-medium transition-opacity ${
                  selected.size > 0
                    ? 'bg-primary-bg-strong text-primary-text hover:opacity-90'
                    : 'bg-surface-inset text-content-muted cursor-not-allowed'
                }`}
              >
                {selected.size === 0
                  ? 'Select files to hand off'
                  : `Copy handoff for ${selected.size} file${selected.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
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
  commentCount,
  enableResolve,
  onViewModeChange,
  onSnapshot,
  onJumpToNext,
  onSearch,
  searchActive,
  onCopyAgentPrompt,
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
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.filePath);
                }
              }}
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
        {/* Search */}
        <IconButton variant="active" active={searchActive} onClick={onSearch} title="Find in document (Cmd+F)">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="m21 21-4.35-4.35" />
          </svg>
        </IconButton>

        <Separator />

        {/* Comment navigation group */}
        {commentCount > 0 && (
          <>
            <IconButton onClick={onJumpToNext} title={enableResolve ? "Jump to next open comment (N)" : "Jump to next comment (N)"}>
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12"
                />
              </svg>
            </IconButton>
            <Separator />
          </>
        )}

        {/* View controls group */}
        <IconButton
          variant="active"
          active={viewMode === 'raw'}
          onClick={() => onViewModeChange(viewMode === 'raw' ? 'rendered' : 'raw')}
          title={viewMode === 'raw' ? 'Switch to rendered view' : 'View raw markdown'}
        >
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
            />
          </svg>
        </IconButton>
        {hasSnapshot && (
          <IconButton
            variant="active"
            active={viewMode === 'diff'}
            onClick={() => onViewModeChange(viewMode === 'diff' ? 'rendered' : 'diff')}
            title={viewMode === 'diff' ? 'Switch to rendered view' : 'View diff since snapshot'}
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
              />
            </svg>
          </IconButton>
        )}
        <IconButton variant="success" active={hasSnapshot} onClick={onSnapshot} title={hasSnapshot ? 'Update diff snapshot' : 'Take diff snapshot'}>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
          </svg>
        </IconButton>

        {/* Separator + Hand off (primary action with multi-file dropdown) */}
        {commentCount > 0 && onCopyAgentPrompt && activeFilePath && (
          <HandOffButton
            activeFilePath={activeFilePath}
            commentCounts={commentCounts}
            onCopyAgentPrompt={onCopyAgentPrompt}
          />
        )}
      </div>
    </div>
  );
}
