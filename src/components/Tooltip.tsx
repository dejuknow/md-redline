import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** Tooltip content. Pass null/empty to suppress (e.g. while a feedback label is shown). */
  text: ReactNode;
  /** Element to anchor the tooltip on (the wrapping span owns pointer events). */
  children: ReactNode;
  /** Show delay in ms when the user hasn't recently dismissed another tooltip. */
  delay?: number;
  /** Where to render relative to the trigger. */
  side?: 'top' | 'bottom';
}

// ---------------------------------------------------------------------------
// Shared "scrubbing" state
// ---------------------------------------------------------------------------
//
// Google Docs / VS Code pattern: the first tooltip in a session has the full
// reveal delay (so it doesn't interrupt a confident user heading for a known
// icon), but if the user is "scrubbing" — moving the pointer from one icon to
// the next — subsequent tooltips appear immediately. We track this with a
// module-level timestamp of the most recent tooltip dismissal: if a new
// tooltip is requested within the grace window (SCRUB_GRACE_MS), it skips
// the delay.
//
// After SCRUB_GRACE_MS of no tooltip activity, the slow reveal returns.
let lastTooltipHiddenAt = 0;
const SCRUB_GRACE_MS = 1000;

/** Test seam: reset the shared scrubbing clock between tests. */
export function _resetTooltipScrubClock(): void {
  lastTooltipHiddenAt = 0;
}

function isScrubbing(): boolean {
  return lastTooltipHiddenAt > 0 && Date.now() - lastTooltipHiddenAt < SCRUB_GRACE_MS;
}

/**
 * Lightweight portal-based tooltip with a configurable show delay. We roll
 * our own instead of relying on the browser's `title=` because the native
 * delay is ~700ms (sluggish for a tightly-packed icon toolbar).
 *
 * Behavior:
 * - The trigger child is wrapped in an inline-flex `<span>` that owns the
 *   pointer/focus handlers. Two reasons for the wrapper rather than
 *   cloneElement-with-ref: (1) the wrapper still gets pointer events on
 *   disabled buttons in browsers that suppress them on the button itself,
 *   and (2) caller-provided components don't need to forwardRef.
 * - The tooltip renders into `document.body` via a portal so it isn't
 *   clipped by ancestor `overflow-y-auto` containers (the panel toolbar
 *   sits inside several of them).
 * - Reveal honors the shared "scrubbing" grace period: a tooltip dismissed
 *   within the last second means the next one shows immediately.
 * - The native `title` attribute on the wrapped element is stashed during
 *   hover and restored on leave, so screen readers and e2e selectors keep
 *   working without the browser's slow native tooltip racing ours.
 */
export function Tooltip({ text, children, delay = 600, side = 'bottom' }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Restore the underlying button's `title` after hover so other code that
  // relies on it (screen readers, tests) keeps working.
  const stashedTitleRef = useRef<{ el: Element; title: string } | null>(null);

  /** Find the actual interactive element inside the wrapper, e.g. the button. */
  const findTrigger = useCallback((): HTMLElement | null => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    const focusable = wrapper.querySelector<HTMLElement>('button, a, [role="button"], input');
    return focusable ?? wrapper;
  }, []);

  const measureAndShow = useCallback(() => {
    const target = findTrigger();
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = side === 'bottom' ? rect.bottom + 6 : rect.top - 6;
    setPos({ x, y });
    setVisible(true);
  }, [findTrigger, side]);

  const cancelTimer = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    cancelTimer();
    // Stash the native title on the inner button so the browser's built-in
    // tooltip never races ours.
    const target = findTrigger();
    if (target && target.hasAttribute('title')) {
      stashedTitleRef.current = { el: target, title: target.getAttribute('title') ?? '' };
      target.removeAttribute('title');
    }
    if (isScrubbing()) {
      // User is scrubbing across icons — show immediately. No timer needed.
      measureAndShow();
    } else {
      showTimerRef.current = setTimeout(measureAndShow, delay);
    }
  }, [cancelTimer, findTrigger, measureAndShow, delay]);

  const handleLeave = useCallback(() => {
    cancelTimer();
    // Only stamp the scrubbing clock if the tooltip actually became visible —
    // otherwise a quick mouse traversal that never triggered a reveal
    // shouldn't unlock instant reveals on neighbours.
    if (visible) {
      lastTooltipHiddenAt = Date.now();
    }
    setVisible(false);
    const stash = stashedTitleRef.current;
    if (stash) {
      stash.el.setAttribute('title', stash.title);
      stashedTitleRef.current = null;
    }
  }, [cancelTimer, visible]);

  // Drop any pending reveal AND restore the trigger's stashed title if the
  // component unmounts mid-hover. Without this, an element that was hovered
  // when its parent re-mounted (e.g. tab switch) would lose its title and
  // ship without the screen-reader fallback or e2e selector.
  useEffect(() => {
    return () => {
      cancelTimer();
      const stash = stashedTitleRef.current;
      if (stash && stash.el.isConnected) {
        stash.el.setAttribute('title', stash.title);
      }
      stashedTitleRef.current = null;
    };
  }, [cancelTimer]);

  return (
    <>
      <span
        ref={wrapperRef}
        // inline-flex keeps the wrapper layout-transparent for the icon-row
        // flex parents the toolbar uses, so wrapping doesn't shift anything.
        className="inline-flex"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
      >
        {children}
      </span>
      {visible && pos && text
        ? createPortal(
            <div
              role="tooltip"
              style={{
                position: 'fixed',
                left: pos.x,
                top: pos.y,
                transform: side === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
              }}
              className="z-[100] pointer-events-none whitespace-nowrap rounded bg-content text-surface text-xs px-2 py-1 shadow-lg"
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
