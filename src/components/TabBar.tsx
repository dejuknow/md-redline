import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useDismiss } from '../hooks/useDismiss';
import { useElementNarrowerThan } from '../hooks/useElementNarrowerThan';
import { getPathBasename, tabDisambiguators } from '../lib/path-utils';

interface Tab {
  filePath: string;
  error: string | null;
  errorKind?: 'access-denied' | 'generic' | null;
}

// A tab waiting on a folder permission is not a failed tab, so its marker is
// neutral. Red stays for the errors the user cannot resolve by answering a
// prompt. Muted rather than faint: this dot is the only signal a background
// denied tab gets, and faint sits under the 3:1 non-text contrast minimum.
function errorDotClass(tab: Tab): string {
  return tab.errorKind === 'access-denied' ? 'bg-content-muted' : 'bg-danger';
}

// The dot is 6px and unlabelled, so the tab's tooltip has to carry the meaning.
function tabTitle(tab: Tab): string {
  if (!tab.error) return tab.filePath;
  const reason =
    tab.errorKind === 'access-denied' ? 'Folder not allowed yet' : `Failed to load: ${tab.error}`;
  return `${tab.filePath}\n${reason}`;
}

/**
 * "This file has resolved comments" (#160): a check in the resolved green, the
 * same meaning as the density strip's resolved ticks. Not a number, because a
 * number on a tab reads as work left, and outline against fill was all that
 * told it apart from the open count. Drawn beside an open count too, so a file
 * with both still turns up when scanning the tabs for resolved comments. The
 * count is in the tooltip and, through the hidden text, the tab's accessible
 * name. Its ink is held to 3:1 on every tab surface by theme-contrast.test.
 */
function ResolvedMark({ count }: { count: number }) {
  const label = `${count} resolved`;
  return (
    <span data-resolved-mark title={label} className="shrink-0 inline-flex text-success-text">
      <svg
        className="w-3 h-3"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
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
  /** Files in a shown review; their tabs carry a crimson line along the top. */
  reviewFilePaths?: Set<string>;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onOpenFile: () => void;
  onTabContextMenu?: (info: TabContextMenuInfo) => void;
}

/**
 * The narrowest the tab row gets before the strip moves its controls to a row
 * of their own: one tab at its 112px floor beside the row's own buttons
 * (scroll left and right, open file, show all tabs: 114px). The active tab,
 * which is up to 200px and does not shrink with the others, caps itself at
 * the scrollport instead (--tabs-port). Below this width, which only a strip
 * narrower than it can force, the scroll arrows step aside and the tab list
 * does their job.
 */
export const TAB_ROW_MIN_WIDTH = 226;

const tabControlButtonClassStrip =
  'self-center flex h-[26px] w-[26px] items-center justify-center shrink-0 rounded-md text-content-muted transition-colors hover:bg-tint hover:text-content-secondary disabled:pointer-events-none disabled:opacity-35';

// Drawn inside the document panel's top row; the row background and its
// bottom rule belong to the strip, not to this component. It sits after the
// tabs' scrollport rather than inside it, so a tab can never scroll under it.
// The button stops 1px short of the bottom so the strip's rule keeps running
// under it; the hover fill is on an inner chip.
// A short hairline at a tab's left edge. Inactive tabs have no fill, so
// these mark where each one ends, and the open-file button reads as the cell
// after the last tab rather than a control floating on the frame. None touches
// the active tab, whose border already draws its edges.
const tabSeparatorClass =
  'before:absolute before:-left-px before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-px before:bg-content-muted/35';

// A review's tabs: a short crimson line inside the tab's top edge, inset from
// its rounded corners so it reads as a straight mark, not a bent rail.
const tabInReviewClass =
  'after:absolute after:top-0 after:left-2.5 after:right-2.5 after:h-0.5 after:rounded-b-full after:bg-primary';

const tabActionButtonClassStrip =
  'group/open flex self-stretch mb-px w-9 items-center justify-center shrink-0 text-content-muted transition-colors hover:text-content';

export function TabBar({
  tabs,
  activeFilePath,
  commentCounts,
  resolvedCommentCounts,
  reviewFilePaths,
  onSwitchTab,
  onCloseTab,
  onOpenFile,
  onTabContextMenu,
}: Props) {
  const tabControlButtonClass = tabControlButtonClassStrip;
  const badgeTextClass = 'text-[12px] px-1.5';
  // Unseen, it sits over the badge or the name's end. With a mouse the
  // pointer hovers it into view on the way; on a touch screen there is no
  // hover, so it takes no taps there and a tap on the badge switches tabs
  // (close by middle-click or the tab's menu instead).
  const renderClose = (tab: Tab, position: string) => (
    <span
      role="button"
      onClick={(e) => {
        e.stopPropagation();
        onCloseTab(tab.filePath);
      }}
      className={`${position} rounded opacity-0 [@media(hover:none)]:pointer-events-none group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:text-content`}
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
  );
  const tabsViewportRef = useRef<HTMLDivElement>(null);
  const tabsContentRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const viewportWidthRef = useRef(-1);
  // Read inside scrollActiveTabIntoView so that callback keeps a stable
  // identity and the resize observer below survives tab switches.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  // Two open files with the same name each show the folder that tells them
  // apart; the full path stays in the tooltip.
  const folderLabels = useMemo(() => tabDisambiguators(tabs.map((t) => t.filePath)), [tabs]);
  const [tabListOpen, setTabListOpen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const cramped = useElementNarrowerThan(rootRef, TAB_ROW_MIN_WIDTH);
  const showScrollArrows = isOverflowing && !cramped;
  // Whether the strip starts on the page's left edge. A desktop shell pads it
  // (--window-inset-left) to clear its window controls in focus mode and on
  // the collapsed rail, and then the first tab no longer stands on the page's
  // corner, so the page keeps that corner rounded (#251).
  const [atPageEdge, setAtPageEdge] = useState(true);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateTabOverflow = useCallback(() => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;
    // The room the scrollport has, for the active tab to cap itself at: it
    // does not shrink with the others, so in a scrollport narrower than it, a
    // long name would be cut mid-word instead of ending in an ellipsis. The
    // row less its buttons, not the scrollport's own width: the scrollport is
    // sized to the tabs, so its width would follow the capped tab down and
    // never let it grow back. Not laid out yet (0) leaves the last value.
    const row = viewport.parentElement;
    if (row) {
      let room = row.getBoundingClientRect().width;
      for (const child of row.children) {
        if (child !== viewport) room -= child.getBoundingClientRect().width;
      }
      if (room > 0) tabsContentRef.current?.style.setProperty('--tabs-port', `${room}px`);
    }

    const maxScrollLeft = Math.max(viewport.scrollWidth - viewport.clientWidth, 0);
    setIsOverflowing(maxScrollLeft > 1);
    setCanScrollLeft(viewport.scrollLeft > 1);
    setCanScrollRight(viewport.scrollLeft < maxScrollLeft - 1);
  }, []);

  // The inset only changes with a resize, which the observer below reports,
  // so this stays off the scroll path. A value that does not parse (no strip
  // around the bar) counts as no inset. A wrapped strip (data-wrapped) has its
  // controls on the row above, and the tab bar reaches back over the inset to
  // the page's edge, so the inset no longer counts.
  const updatePageEdge = useCallback(() => {
    const strip = tabsViewportRef.current?.closest<HTMLElement>('[data-doc-strip]');
    const inset = strip ? parseFloat(getComputedStyle(strip).paddingLeft) : 0;
    setAtPageEdge(!(inset > 0.5) || strip?.dataset.wrapped !== undefined);
  }, []);

  // Bring the active tab into view. The open-file button sits after the
  // scrollport, not inside it, so nothing in the scrollport can cover a tab
  // and it needs no scroll-padding.
  // Reports whether there was a tab to align, so a caller that tracks state
  // across calls can tell an alignment from a no-op.
  const scrollActiveTabIntoView = useCallback(() => {
    const activePath = activeFilePathRef.current;
    const tabButton = activePath ? tabButtonRefs.current.get(activePath) : null;
    if (!tabButton) return false;

    tabButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
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
    updatePageEdge();

    const handleScroll = () => updateTabOverflow();
    viewport.addEventListener('scroll', handleScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            // The scrollport keeps narrowing after the active tab was scrolled
            // into view (the overflow arrows mount, the explorer opens, the
            // window resizes), and a scroll position computed against the old
            // width leaves the active tab clipped. Re-align on width changes
            // only, so content growth such as a new comment badge doesn't yank
            // the strip back while the user is looking at another tab.
            // Fractional width, not clientWidth: a sub-pixel settle at the end
            // of the explorer's open animation rounds to the same integer and
            // would skip the last re-align. Record the width only once an
            // alignment actually ran, so a resize that lands before the active
            // tab has mounted gets another chance.
            const width = viewport.getBoundingClientRect().width;
            if (width !== viewportWidthRef.current && scrollActiveTabIntoView()) {
              viewportWidthRef.current = width;
            }
            updateTabOverflow();
            updatePageEdge();
          })
        : null;

    resizeObserver?.observe(viewport);
    if (tabsContentRef.current) resizeObserver?.observe(tabsContentRef.current);
    // The strip too: a window inset that comes or goes (focus mode, a zoom
    // change) narrows its content box even when the tabs fit either way, and
    // updatePageEdge re-reads the inset from it.
    const strip = viewport.closest('[data-doc-strip]');
    if (strip) resizeObserver?.observe(strip);
    // And the bar itself: it widens over the inset when the strip wraps, which
    // moves its left edge without resizing the strip or, if the tabs fit
    // either way, the scrollport.
    if (rootRef.current) resizeObserver?.observe(rootRef.current);

    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
    };
    // tabs.length is not a stale-closure leftover: rebuilding the observer
    // re-delivers an observation once the tabs arrive, which is the other half
    // of the retry above. The obvious simplification is to move that retry to
    // the alignment effect below, whose stated job it already is. Don't: that
    // effect aligns unconditionally, so every background tab open would pull
    // the strip off whatever the user is reading. Both halves are pinned by
    // TabBar.test.tsx.
  }, [tabs.length, scrollActiveTabIntoView, updateTabOverflow, updatePageEdge]);

  useEffect(() => {
    if (!activeFilePath) return;

    const frame = window.requestAnimationFrame(() => {
      scrollActiveTabIntoView();
      updateTabOverflow();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeFilePath, scrollActiveTabIntoView, updateTabOverflow]);

  // Closes on a press or focus outside, and on Escape, which it keeps to
  // itself like the strip's other menus: an Escape that closes the list does
  // not also close the find bar or clear a selection.
  const closeTabList = useCallback(() => setTabListOpen(false), []);
  useDismiss(tabListOpen, tabListRef, closeTabList);

  useEffect(() => {
    if (!isOverflowing) setTabListOpen(false);
  }, [isOverflowing]);

  return (
    <div
      ref={rootRef}
      // -mb-px lays the row over the strip's bottom rule, so the active
      // tab can cover it and join the page below.
      className="flex-1 self-stretch -mb-px flex items-stretch min-w-0"
    >
      <div className="min-w-0 flex-1 flex items-stretch">
        {showScrollArrows && (
          <button
            type="button"
            onClick={() => scrollTabsBy('left')}
            disabled={!canScrollLeft}
            className={tabControlButtonClass}
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

        {/* Sized to the tabs' natural widths (flex-basis auto) and allowed to
            shrink: the tabs then shrink toward their floors before anything
            scrolls, and overflow past the floors is what scrolls. */}
        <div ref={tabsViewportRef} className="min-w-0 h-full overflow-x-auto no-scrollbar">
          <div ref={tabsContentRef} className="flex h-full items-end gap-0.5">
            {tabs.map((tab, index) => {
              const isActive = tab.filePath === activeFilePath;
              const fileName = getPathBasename(tab.filePath) || tab.filePath;
              const count = commentCounts.get(tab.filePath) ?? 0;
              const resolvedCount = resolvedCommentCounts?.get(tab.filePath) ?? 0;
              const hasMarks = count > 0 || resolvedCount > 0 || !!tab.error;
              const inReview = reviewFilePaths?.has(tab.filePath) ?? false;
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
                  className={`group relative flex items-center gap-1.5 px-3 leading-none text-[13px] rounded-t-lg transition-colors ${
                    index > 0 && !isActive && tabs[index - 1].filePath !== activeFilePath
                      ? tabSeparatorClass
                      : ''
                  } ${inReview ? tabInReviewClass : ''} ${
                    isActive
                      ? 'h-[35px] shrink-0 min-w-[min(112px,var(--tabs-port,112px))] max-w-[min(200px,var(--tabs-port,200px))] bg-surface border border-border border-b-0 text-content font-medium'
                      : 'h-[34px] shrink min-w-[112px] max-w-[200px] border border-transparent border-b-0 text-content-muted hover:text-content'
                  }`}
                  title={tabTitle(tab)}
                  data-tab-in-review={inReview ? '' : undefined}
                  // The active first tab stands on the page's left edge, so the
                  // page squares that corner (index.css) and the two read as one.
                  data-tab-flush={
                    isActive && index === 0 && !isOverflowing && atPageEdge ? '' : undefined
                  }
                >
                  {/* The name always takes its medium-weight width (an invisible
                      copy drawn by ::after), so a tab is the same size active
                      or not. */}
                  <span
                    data-label={fileName}
                    className="min-w-0 flex flex-col after:content-[attr(data-label)] after:h-0 after:overflow-hidden after:invisible after:font-medium after:whitespace-nowrap"
                  >
                    <span className="truncate">{fileName}</span>
                  </span>
                  {folderLabels.has(tab.filePath) && (
                    // Already short (tabDisambiguators keeps it to about 96px),
                    // and it gives way long before the name does: a tab is
                    // found by its file name, so that is the last thing to go.
                    <span
                      data-tab-folder
                      className="min-w-0 max-w-[96px] shrink-[100] -ml-0.5 truncate text-[12px] font-normal text-content-muted"
                    >
                      {folderLabels.get(tab.filePath)}
                    </span>
                  )}
                  {hasMarks ? (
                    // A tab with marks swaps them for its close button on
                    // hover, so the x never lands on half a badge.
                    <span className="relative shrink-0 flex items-center">
                      <span className="flex items-center gap-1.5 group-hover:invisible">
                        {count > 0 && (
                          <span
                            className={`${badgeTextClass} font-medium min-w-[16px] text-center rounded-full shrink-0 ${
                              isActive
                                ? 'bg-primary-bg-strong text-primary-text'
                                : 'bg-surface-inset text-content-secondary'
                            }`}
                          >
                            {count}
                          </span>
                        )}
                        {resolvedCount > 0 && <ResolvedMark count={resolvedCount} />}
                        {tab.error && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${errorDotClass(tab)}`}
                          />
                        )}
                      </span>
                      {renderClose(tab, 'absolute inset-0 flex items-center justify-center')}
                    </span>
                  ) : (
                    // No tab keeps room for its close button: on hover it
                    // appears over the name's end, on a patch of the tab's own
                    // fill that fades into the text. Active or not, a tab is
                    // then the width of its name, so switching tabs never
                    // resizes one or moves its neighbours.
                    renderClose(
                      tab,
                      `absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 ${
                        isActive
                          ? 'bg-surface shadow-[-10px_0_8px_-2px_var(--color-surface)]'
                          : 'bg-frame shadow-[-10px_0_8px_-2px_var(--color-frame)]'
                      }`,
                    )
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenFile}
          className={`${tabActionButtonClassStrip} relative ${
            tabs.length > 0 && tabs[tabs.length - 1].filePath !== activeFilePath
              ? tabSeparatorClass
              : ''
          }`}
          title="Open file"
          aria-label="Open file"
        >
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors group-hover/open:bg-tint">
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </span>
        </button>

        {isOverflowing && (
          <>
            {showScrollArrows && (
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
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m8.25 4.5 7.5 7.5-7.5 7.5"
                  />
                </svg>
              </button>
            )}

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
                        title={tabTitle(tab)}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-primary' : 'bg-transparent'}`}
                        />
                        <span
                          className={`text-xs truncate flex-1 ${isActive ? 'text-content font-medium' : 'text-content'}`}
                        >
                          {fileName}
                          {folderLabels.has(tab.filePath) && (
                            <span className="ml-1.5 font-normal text-content-muted">
                              {folderLabels.get(tab.filePath)}
                            </span>
                          )}
                        </span>
                        {count > 0 && (
                          <span
                            className={`${badgeTextClass} font-medium min-w-[16px] text-center rounded-full shrink-0 ${
                              isActive
                                ? 'bg-primary-bg-strong text-primary-text'
                                : 'bg-surface-inset text-content-secondary'
                            }`}
                          >
                            {count}
                          </span>
                        )}
                        {resolvedCount > 0 && <ResolvedMark count={resolvedCount} />}
                        {tab.error && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${errorDotClass(tab)}`}
                          />
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
