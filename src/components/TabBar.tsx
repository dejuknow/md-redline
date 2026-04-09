import { useState, useRef, useEffect, useCallback } from 'react';
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
  resolvedCommentCounts?: Map<string, number>;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onOpenFile: () => void;
  onTabContextMenu?: (info: TabContextMenuInfo) => void;
}

const tabControlButtonClass =
  'flex h-full w-8 items-center justify-center shrink-0 border-l border-border text-content-muted transition-colors hover:bg-tint hover:text-content-secondary disabled:pointer-events-none disabled:opacity-35';

const tabActionButtonClass =
  'sticky right-0 z-10 flex h-full items-center justify-center bg-surface-secondary px-2.5 shrink-0 border-r border-border text-content-muted transition-colors hover:bg-tint hover:text-content';

export function TabBar({
  tabs,
  activeFilePath,
  commentCounts,
  resolvedCommentCounts,
  onSwitchTab,
  onCloseTab,
  onOpenFile,
  onTabContextMenu,
}: Props) {
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
              const resolvedCount = resolvedCommentCounts?.get(tab.filePath) ?? 0;
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
                  {count > 0 ? (
                    <span
                      className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                        isActive
                          ? 'bg-primary-bg-strong text-primary-text'
                          : 'bg-surface-inset text-content-secondary'
                      }`}
                    >
                      {count}
                    </span>
                  ) : resolvedCount > 0 ? (
                    <span
                      className="text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 border border-border-subtle text-content-muted"
                      title={`${resolvedCount} resolved`}
                    >
                      {resolvedCount}
                    </span>
                  ) : null}
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
                    const resolvedCount = resolvedCommentCounts?.get(tab.filePath) ?? 0;
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
                        {count > 0 ? (
                          <span
                            className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                              isActive
                                ? 'bg-primary-bg-strong text-primary-text'
                                : 'bg-surface-inset text-content-secondary'
                            }`}
                          >
                            {count}
                          </span>
                        ) : resolvedCount > 0 ? (
                          <span
                            className="text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 border border-border-subtle text-content-muted"
                            title={`${resolvedCount} resolved`}
                          >
                            {resolvedCount}
                          </span>
                        ) : null}
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

    </div>
  );
}
