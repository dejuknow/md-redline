import { useCallback, useLayoutEffect, useEffect, useRef, useState } from 'react';

/** One action of a review row, as a button or a More menu item. */
export interface RowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

const MENU_ITEM =
  'w-full flex items-center px-3 py-1.5 text-left text-[13px] text-content whitespace-nowrap transition-colors hover:bg-tint disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

/** Keeps a popup this far from the window's edges. */
const VIEWPORT_MARGIN = 8;

/**
 * Closes a popup on a press outside `ref`, on focus moving outside it (a
 * palette or find bar opened by keyboard takes the focus), or on Escape.
 * Escape is caught on the way down and stopped there, so App's own Escape
 * handling never sees it, unless another overlay is open: that Escape is the
 * overlay's.
 */
export function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      ref.current !== null && !ref.current.contains(target as Node);
    const onPointerDown = (e: MouseEvent) => {
      if (outside(e.target)) close();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const otherOverlay = Array.from(
        document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
      ).some((el) => outside(el));
      if (otherOverlay) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, ref, close]);
}

/** The compact row's overflow: its quiet and secondary actions, in that order. */
export function MoreReviewActions({ items }: { items: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        className={`h-7 w-8 flex items-center justify-center rounded-md transition-colors ${
          open ? 'bg-tint text-content' : 'text-content-secondary hover:text-content hover:bg-tint'
        }`}
        onClick={() => setOpen((o) => !o)}
        aria-label="More review actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More review actions"
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More review actions"
          className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-lg border border-border bg-surface shadow-lg py-1"
        >
          {items.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={a.disabled}
              title={a.title}
              aria-label={a.ariaLabel}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The header's "+N" button and the popover listing the other reviews. The
 * popover hangs from the nearest positioned ancestor's right edge (the
 * banner's), so it has the row's width to open into, and is nudged back
 * inside the window when that edge sits too far left or right, again
 * whenever the window or the banner changes size while it is open.
 *
 * `withQuestions` counts the other reviews with an agent question waiting; any
 * puts a dot on the button and says so in its name.
 */
export function OtherReviews({
  count,
  withQuestions = 0,
  children,
}: {
  count: number;
  withQuestions?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!open || !el) return;
    const place = () => {
      el.style.transform = '';
      const r = el.getBoundingClientRect();
      const maxRight = window.innerWidth - VIEWPORT_MARGIN;
      const dx =
        r.left < VIEWPORT_MARGIN
          ? VIEWPORT_MARGIN - r.left
          : r.right > maxRight
            ? maxRight - r.right
            : 0;
      if (dx !== 0) el.style.transform = `translateX(${dx}px)`;
    };
    place();
    window.addEventListener('resize', place);
    // The banner moves under an open popover when the header's other items
    // change width (a notice appearing, say), with no window resize.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (observer) {
      if (el.offsetParent) observer.observe(el.offsetParent);
      if (ref.current) observer.observe(ref.current);
    }
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [open]);

  const othersLabel = `${count} other review${count === 1 ? '' : 's'}`;
  const questionsLabel = withQuestions > 0 ? `${withQuestions} with questions` : null;

  return (
    <div ref={ref} className="shrink-0">
      <button
        type="button"
        className={`h-7 px-2 flex items-center gap-1.5 rounded-md text-[13px] font-medium tabular-nums transition-colors ${
          open ? 'bg-tint text-content' : 'text-content-secondary hover:text-content hover:bg-tint'
        }`}
        onClick={() => setOpen((o) => !o)}
        aria-label={questionsLabel ? `Other reviews, ${questionsLabel}` : 'Other reviews'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={questionsLabel ? `${othersLabel}, ${questionsLabel}` : othersLabel}
      >
        +{count}
        {questionsLabel && (
          <span
            data-questions-marker
            className="inline-block h-2 w-2 rounded-full bg-primary"
            aria-hidden
          />
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Other reviews"
          data-review-popover
          className="absolute right-0 top-full z-50 mt-1 w-[min(560px,calc(100vw-16px))] rounded-lg border border-border bg-surface shadow-lg px-3 py-1.5 divide-y divide-border-subtle"
        >
          {children}
        </div>
      )}
    </div>
  );
}
