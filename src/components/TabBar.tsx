import { useState, useRef, useEffect, useCallback } from 'react';
import type { ViewMode } from './Toolbar';
import { getPrimaryModifierLabel } from '../lib/platform';
import { IconButton } from './IconButton';
import { SplitIconButton } from './SplitIconButton';
import { getPathBasename } from '../lib/path-utils';

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
  diffPending?: boolean;
  commentCount: number;
  enableResolve?: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onClearSnapshot: () => void;
  onSearch: () => void;
  searchActive: boolean;
  onCopyAgentPrompt?: (filePaths: string[]) => void;
}

const tabControlButtonClass =
  'flex h-full w-8 items-center justify-center shrink-0 border-l border-border text-content-muted transition-colors hover:bg-tint hover:text-content-secondary disabled:pointer-events-none disabled:opacity-35';

const tabActionButtonClass =
  'sticky right-0 z-10 flex h-full items-center justify-center bg-surface-secondary px-2.5 shrink-0 border-r border-border text-content-muted transition-colors hover:bg-tint hover:text-content';

const handOffIcon = (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    {/* antenna */}
    <line x1="12" y1="1.5" x2="12" y2="4.5" strokeLinecap="round" />
    <circle cx="12" cy="1.5" r="1" fill="currentColor" stroke="none" />
    {/* head */}
    <rect x="3" y="4.5" width="18" height="17" rx="3" strokeLinejoin="round" />
    {/* eyes */}
    <circle cx="8" cy="11.5" r="2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="11.5" r="2" fill="currentColor" stroke="none" />
    {/* mouth */}
    <line x1="8.5" y1="17.5" x2="15.5" y2="17.5" strokeLinecap="round" />
    {/* ears */}
    <line x1="0.5" y1="13" x2="3" y2="13" strokeLinecap="round" />
    <line x1="21" y1="13" x2="23.5" y2="13" strokeLinecap="round" />
  </svg>
);

function HandOffButton({
  activeFilePath,
  commentCounts,
  onCopyAgentPrompt,
}: {
  activeFilePath: string;
  commentCounts: Map<string, number>;
  onCopyAgentPrompt: (filePaths: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // All files with comments
  const filesWithComments = Array.from(commentCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([path, count]) => ({ path, count }));

  const hasMultipleFiles = filesWithComments.length > 1;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!hasMultipleFiles) {
    return (
      <div className="relative flex items-center" data-testid="handoff-group">
          <IconButton
            variant="neutral"
            onClick={() => onCopyAgentPrompt([activeFilePath])}
            title="Hand off to agent — copy instructions for this file"
            data-testid="handoff-button"
          >
            {handOffIcon}
          </IconButton>
          <button
            type="button"
            title="Hand off multiple files"
            data-testid="handoff-chevron"
            aria-hidden="true"
            tabIndex={-1}
            className="pl-0 pr-0.5 self-stretch flex items-center rounded-r opacity-0 pointer-events-none text-content-muted"
          >
            <svg
              className="w-2 h-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        </div>
    );
  }

  return (
    <div className="relative flex items-center" data-testid="handoff-group">
        <SplitIconButton
          icon={handOffIcon}
          onClick={() => onCopyAgentPrompt([activeFilePath])}
          title="Hand off to agent — copy instructions for this file"
          testId="handoff-button"
          chevronTestId="handoff-chevron"
          chevronTitle="Hand off multiple files"
          onOpen={() => setSelected(new Set(filesWithComments.map((f) => f.path)))}
          dropdown={(close) => {
            const handleCopySelected = () => {
              const paths = Array.from(selected);
              if (paths.length === 0) return;
              onCopyAgentPrompt(paths);
              close();
            };

            return (
              <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1.5 min-w-[240px]">
                {filesWithComments.map(({ path, count }) => {
                  const isSelected = selected.has(path);
                  const isActive = path === activeFilePath;
                  return (
                    <button
                      key={path}
                      onClick={() => toggle(path)}
                      className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-tint transition-colors"
                      title={path}
                    >
                      <span className="w-3 h-3 shrink-0 flex items-center justify-center">
                        {isSelected && (
                          <svg
                            className="w-3 h-3 text-primary-text"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M4.5 12.75l6 6 9-13.5"
                            />
                          </svg>
                        )}
                      </span>
                      <span
                        className={`text-xs truncate flex-1 text-left ${isActive ? 'text-content font-medium' : 'text-content'}`}
                      >
                        {getPathBasename(path)}
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
            );
          }}
        />
      </div>
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
  diffPending,
  commentCount,
  onViewModeChange,
  onClearSnapshot,
  onSearch,
  searchActive,
  onCopyAgentPrompt,
}: Props) {
  const modLabel = getPrimaryModifierLabel();
  const tabsViewportRef = useRef<HTMLDivElement>(null);
  const tabsContentRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [tabListOpen, setTabListOpen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateTabOverflow = useCallback(() => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;

    const maxScrollLeft = Math.max(viewport.scrollWidth - viewport.clientWidth, 0);
    setIsOverflowing(maxScrollLeft > 1);
    setCanScrollLeft(viewport.scrollLeft > 1);
    setCanScrollRight(viewport.scrollLeft < maxScrollLeft - 1);
  }, []);

  const scrollTabsBy = useCallback((direction: 'left' | 'right') => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;

    const distance = Math.max(Math.round(viewport.clientWidth * 0.6), 160);
    viewport.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;

    updateTabOverflow();

    const handleScroll = () => updateTabOverflow();
    viewport.addEventListener('scroll', handleScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateTabOverflow()) : null;

    resizeObserver?.observe(viewport);
    if (tabsContentRef.current) resizeObserver?.observe(tabsContentRef.current);

    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
    };
  }, [tabs.length, updateTabOverflow]);

  useEffect(() => {
    if (!activeFilePath) return;

    const frame = window.requestAnimationFrame(() => {
      tabButtonRefs.current
        .get(activeFilePath)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateTabOverflow();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeFilePath, updateTabOverflow]);

  useEffect(() => {
    if (!tabListOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (tabListRef.current && !tabListRef.current.contains(event.target as Node)) {
        setTabListOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTabListOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [tabListOpen]);

  useEffect(() => {
    if (!isOverflowing) setTabListOpen(false);
  }, [isOverflowing]);


  return (
    <div className="h-9 bg-surface-secondary border-b border-border flex items-stretch shrink-0">
      <div className="min-w-0 flex-1 flex items-stretch">
        {isOverflowing && (
          <button
            type="button"
            onClick={() => scrollTabsBy('left')}
            disabled={!canScrollLeft}
            className={`${tabControlButtonClass} border-r border-l-0`}
            title="Scroll tabs left"
            aria-label="Scroll tabs left"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 19.5-7.5-7.5 7.5-7.5" />
            </svg>
          </button>
        )}

        <div ref={tabsViewportRef} className="min-w-0 flex-1 h-full overflow-x-auto no-scrollbar">
          <div ref={tabsContentRef} className="flex h-full items-stretch min-w-max">
            {tabs.map((tab) => {
              const isActive = tab.filePath === activeFilePath;
              const fileName = getPathBasename(tab.filePath) || tab.filePath;
              const count = commentCounts.get(tab.filePath) ?? 0;
              return (
                <button
                  key={tab.filePath}
                  ref={(node) => {
                    if (node) tabButtonRefs.current.set(tab.filePath, node);
                    else tabButtonRefs.current.delete(tab.filePath);
                  }}
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
                  className={`group flex h-full items-center gap-1.5 px-3 text-xs leading-none border-r border-border border-b-2 shrink-0 max-w-[200px] transition-colors ${
                    isActive
                      ? 'bg-surface text-content font-medium border-b-primary'
                      : 'border-b-transparent text-content-secondary hover:text-content hover:bg-tint'
                  }`}
                  title={tab.filePath}
                >
                  <span className="truncate">{fileName}</span>
                  {count > 0 && (
                    <span
                      className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                        isActive
                          ? 'bg-primary-bg-strong text-primary-text'
                          : 'bg-surface-inset text-content-secondary'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                  {tab.error && <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />}
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.filePath);
                    }}
                    className={`ml-1 p-0.5 rounded hover:bg-tint shrink-0 transition-opacity ${
                      isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    aria-label={`Close ${getPathBasename(tab.filePath)}`}
                    tabIndex={-1}
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
              type="button"
              onClick={onOpenFile}
              className={tabActionButtonClass}
              title="Open file"
              aria-label="Open file"
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
        </div>

        {isOverflowing && (
          <>
            <button
              type="button"
              onClick={() => scrollTabsBy('right')}
              disabled={!canScrollRight}
              className={tabControlButtonClass}
              title="Scroll tabs right"
              aria-label="Scroll tabs right"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
            </button>

            <div ref={tabListRef} className="relative flex items-stretch shrink-0">
              <button
                type="button"
                onClick={() => setTabListOpen((open) => !open)}
                className={`${tabControlButtonClass} ${
                  tabListOpen ? 'bg-surface-inset text-content-secondary' : ''
                }`}
                title="Show all open tabs"
                aria-label="Show all open tabs"
                aria-haspopup="menu"
                aria-expanded={tabListOpen}
                data-testid="tab-list-button"
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
                    d="M5.25 6.75h13.5M5.25 12h13.5M5.25 17.25h13.5"
                  />
                </svg>
              </button>

              {tabListOpen && (
                <div
                  className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-surface shadow-lg py-1.5"
                  data-testid="tab-list-menu"
                >
                  {tabs.map((tab) => {
                    const isActive = tab.filePath === activeFilePath;
                    const fileName = getPathBasename(tab.filePath) || tab.filePath;
                    const count = commentCounts.get(tab.filePath) ?? 0;
                    return (
                      <button
                        key={tab.filePath}
                        type="button"
                        onClick={() => {
                          onSwitchTab(tab.filePath);
                          setTabListOpen(false);
                        }}
                        className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors ${
                          isActive ? 'bg-surface-inset' : 'hover:bg-tint'
                        }`}
                        title={tab.filePath}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-primary' : 'bg-transparent'}`}
                        />
                        <span
                          className={`text-xs truncate flex-1 ${isActive ? 'text-content font-medium' : 'text-content'}`}
                        >
                          {fileName}
                        </span>
                        {count > 0 && (
                          <span
                            className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                              isActive
                                ? 'bg-primary-bg-strong text-primary-text'
                                : 'bg-surface-inset text-content-secondary'
                            }`}
                          >
                            {count}
                          </span>
                        )}
                        {tab.error && (
                          <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Document actions (right side) */}
      <div className="flex items-center gap-0.5 px-2 shrink-0 border-l border-border">
        {/* Search */}
        <IconButton
          variant="active"
          active={searchActive}
          onClick={onSearch}
          title={`Find in document (${modLabel}+F)`}
        >
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="m21 21-4.35-4.35" />
          </svg>
        </IconButton>

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
          <SplitIconButton
            icon={
              <span className="relative">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
                  />
                </svg>
                {diffPending && viewMode !== 'diff' && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-primary animate-pulse" />
                )}
              </span>
            }
            onClick={() => onViewModeChange(viewMode === 'diff' ? 'rendered' : 'diff')}
            title={viewMode === 'diff' ? 'Switch to rendered view' : 'View diff since snapshot'}
            variant="active"
            active={viewMode === 'diff'}
            chevronTitle="Diff options"
            menu={[
              { label: 'Clear snapshot', onClick: onClearSnapshot },
            ]}
          />
        )}

        {/* Hand off (primary action with multi-file dropdown) */}
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
