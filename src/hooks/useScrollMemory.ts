import { Component, useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  captureViewportAnchor,
  viewportAnchorScrollTop,
  type ViewportAnchor,
} from '../lib/viewport-anchor';

/**
 * The views a document is read in, each with its own positions: the same
 * offset is different text in the rendered view and in raw, and only the
 * rendered view has blocks to anchor on.
 */
export type ReadingView = 'rendered' | 'raw';

const STORAGE_KEYS: Record<ReadingView, string> = {
  rendered: 'md-redline-scroll-positions',
  raw: 'md-redline-raw-scroll-positions',
};

/**
 * Where the reader was in one document: the block they were reading (see
 * lib/viewport-anchor.ts), and the pixel offset as a fallback for when that
 * block cannot be found: it was edited, the reader was at the very top, or the
 * view has no blocks (raw).
 */
interface SavedPosition {
  top: number;
  anchor?: ViewportAnchor;
}

function isSavedPosition(value: unknown): value is SavedPosition {
  if (typeof value !== 'object' || value === null) return false;
  const { top, anchor } = value as { top?: unknown; anchor?: unknown };
  if (typeof top !== 'number' || !Number.isFinite(top)) return false;
  if (anchor === undefined) return true;
  if (typeof anchor !== 'object' || anchor === null) return false;
  const { key, ordinal, offset } = anchor as Record<string, unknown>;
  return typeof key === 'string' && typeof ordinal === 'number' && typeof offset === 'number';
}

/**
 * Positions live in sessionStorage rather than in a ref so a refresh
 * mid-review returns every document to where the reader left it.
 * sessionStorage and not localStorage: a position is worth keeping for as long
 * as the tab is open and no longer; a document reopened days later should
 * start at the top.
 */
function loadPositions(view: ReadingView): Record<string, SavedPosition> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS[view]);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const positions: Record<string, SavedPosition> = {};
    for (const [path, position] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSavedPosition(position)) positions[path] = position;
    }
    return positions;
  } catch {
    return {};
  }
}

function savePosition(view: ReadingView, path: string, position: SavedPosition): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEYS[view],
      JSON.stringify({ ...loadPositions(view), [path]: position }),
    );
  } catch {
    /* a full or unavailable store costs the memory, not the review */
  }
}

/**
 * Scroll to a saved position: to its block when that block is in the
 * document, otherwise to its pixel offset, which the browser clamps to the
 * bottom of a document now too short for it.
 */
function restorePosition(
  scroller: HTMLElement,
  blocks: Element | null,
  position: SavedPosition,
): void {
  const anchored =
    position.anchor && blocks
      ? viewportAnchorScrollTop(scroller, blocks, position.anchor)
      : undefined;
  // `behavior: 'instant'` overrides the `scroll-behavior: smooth` the viewer
  // has (index.css, `.overflow-y-auto`). A restore is not navigation the
  // reader asked for; animating it reads as the document scrolling itself.
  scroller.scrollTo({ top: anchored ?? position.top, behavior: 'instant' });
}

/** Saves the position of the document being left, in the view it was shown in. */
export type CaptureReadingPosition = (path: string, view: ReadingView | null) => void;

interface ScrollMemoryOptions {
  /** The scroll container the documents share (the raw view's, in raw). */
  containerRef: RefObject<HTMLElement | null>;
  /** The element whose children are the rendered document's top-level blocks
   *  (MarkdownViewer's container), or null when the viewer is not mounted. */
  getBlocks: () => Element | null;
  activeFilePath: string | null;
  /** The view the scroller is showing, or null while it shows something whose
   *  position is not kept: the diff, in either view, whose layout (removed
   *  text interleaved, scrolled to its first change on open) is neither
   *  view's. */
  view: ReadingView | null;
  /** False until the active document's body is on screen: during its first
   *  load, after a first load that failed, and before settings (Document
   *  width) have arrived. */
  rendered: boolean;
  /** Asked right before a restore. True hands the arriving document to a
   *  scroll already under way, which an instant restore would abort. */
  restoreYields?: () => boolean;
}

/**
 * Remembers where the reader was in each document, so switching tabs or
 * reloading returns them to the same text instead of applying one document's
 * offset to the next. One position per file visited and per view, for the life
 * of the browser tab; nothing prunes them. A document not visited yet opens at
 * the top.
 *
 * Returns the capture to hand to ReadingPositionCapture, which calls it with
 * the document being left before React's commit changes the DOM: see there for
 * why the read cannot happen in an effect. A refresh, or a browser tab sent to
 * the background (which the browser may discard without a pagehide), never
 * switches away, so the hook also saves the active document on pagehide and
 * when the page is hidden. Every save reads the live scroller and blocks at
 * that moment: the raw view and the diff overlay each mount their own
 * scroller or viewer, so an element held from an earlier render may be
 * detached.
 *
 * `rendered` is false while the active document's body is not on screen: a tab
 * activated during its first load has neither the saved block nor the height
 * for the saved offset, and one whose first load failed shows only an error,
 * so the restore waits for the content that Allow or Reload brings. Once the
 * body has rendered the restore runs once and is done, whether or not it
 * landed. A saved block that is gone, in a document now shorter than the saved
 * offset (an agent cut the section while the tab was in the background),
 * leaves the reader at the bottom; retrying it would pull them back there on
 * every later edit, and leaving the tab would save the unreachable target over
 * where they scrolled to. A document left before its restore ran keeps the
 * position the restore was waiting for: the reader never saw it.
 *
 * A Raw/Rendered toggle saves the view being left and opens the other at the
 * top, as it always has. What restores is an arrival: a tab switch, a reopen,
 * a reload, or the diff closing over the view it covered.
 */
export function useScrollMemory({
  containerRef,
  getBlocks,
  activeFilePath,
  view,
  rendered,
  restoreYields,
}: ScrollMemoryOptions): CaptureReadingPosition {
  // The document the scroller is showing, and in which view. Null with no
  // document open.
  const shown = useRef<{ path: string; view: ReadingView | null } | null>(null);
  // Whether that document still has its restore to run.
  const restoreOwed = useRef(false);

  const capture = useCallback<CaptureReadingPosition>(
    (path, leftView) => {
      // Not restored yet, so not seen yet: the store still holds the position
      // the restore was waiting to put the reader at.
      if (restoreOwed.current && shown.current?.path === path) return;
      if (leftView === null) return;
      const el = containerRef.current;
      if (!el) return;
      const blocks = leftView === 'rendered' ? getBlocks() : null;
      savePosition(leftView, path, {
        top: el.scrollTop,
        anchor: blocks ? captureViewportAnchor(el, blocks) : undefined,
      });
    },
    [containerRef, getBlocks],
  );

  useEffect(() => {
    const saveShown = () => {
      if (shown.current) capture(shown.current.path, shown.current.view);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') saveShown();
    };
    window.addEventListener('pagehide', saveShown);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', saveShown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [capture]);

  useLayoutEffect(() => {
    if (activeFilePath === null) {
      // The last tab closed. Forget its document, so reopening it is an
      // arrival like any other and gets its restore.
      shown.current = null;
      restoreOwed.current = false;
      return;
    }
    // An arrival: another document, or the view beneath the diff coming back
    // when the diff closes. The reader left that view's place when the diff
    // opened (the capture saved it), and wherever the diff took them since is
    // nowhere in the view it covered.
    const prev = shown.current;
    if (prev === null || prev.path !== activeFilePath || (prev.view === null && view !== null)) {
      restoreOwed.current = true;
    }
    shown.current = { path: activeFilePath, view };
    // A restore into the diff waits for the view underneath it.
    if (!restoreOwed.current || !rendered || view === null) return;
    // Spent here whether or not it can run. A restore with no scroller to
    // land in is skipped, not kept owed: an owed restore makes every save of
    // this document keep the stored position, so the reader's place would
    // never be saved again.
    restoreOwed.current = false;
    const el = containerRef.current;
    if (!el) return;
    if (restoreYields?.()) return;
    restorePosition(
      el,
      view === 'rendered' ? getBlocks() : null,
      loadPositions(view)[activeFilePath] ?? { top: 0 },
    );
  }, [containerRef, getBlocks, activeFilePath, view, rendered, restoreYields]);

  return capture;
}

interface ReadingPositionCaptureProps {
  /** The active document, or null with none open. */
  path: string | null;
  /** The view it is shown in (see useScrollMemory's `view`). */
  view: ReadingView | null;
  /** useScrollMemory's capture. */
  onLeave: CaptureReadingPosition;
}

/**
 * Saves the outgoing document's position from the DOM as it was before the
 * commit that switches documents (or views) touched it. Renders nothing.
 *
 * An effect would read too late. React applies a commit's DOM changes in its
 * mutation phase, deletions and insertions and attribute updates alike, and
 * runs a parent's layout-effect cleanups there AFTER its subtree's own
 * changes. So whenever React itself changes the DOM on the switch, a cleanup
 * in App reads the arriving layout: the diff overlay keyed by path, the raw
 * view's own scroller, or a column width that changes because only one of the
 * documents reserves the comment rail's gutter. Only MarkdownViewer's
 * innerHTML swap waits for layout effects.
 *
 * getSnapshotBeforeUpdate is React's hook for this read. It runs in the
 * before-mutation phase, for the whole tree, before any of the commit's DOM
 * changes, so the scroller and the viewer's blocks still hold the document
 * being left. A class component because hooks have no equivalent.
 */
export class ReadingPositionCapture extends Component<ReadingPositionCaptureProps> {
  getSnapshotBeforeUpdate(prev: Readonly<ReadingPositionCaptureProps>): null {
    if (prev.path !== null && (prev.path !== this.props.path || prev.view !== this.props.view)) {
      this.props.onLeave(prev.path, prev.view);
    }
    return null;
  }

  // React warns about a getSnapshotBeforeUpdate with no componentDidUpdate to
  // receive its snapshot. The save is already done; nothing to receive.
  componentDidUpdate(): void {}

  render(): null {
    return null;
  }
}
