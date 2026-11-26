import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether an element is rendered narrower than `px`, kept current with a
 * ResizeObserver. It stores the boolean, not the width, so a resize that stays
 * on one side of the threshold commits no render. False until the first
 * measurement, and it stays false where ResizeObserver is missing (jsdom).
 */
export function useElementNarrowerThan<T extends HTMLElement>(
  ref: RefObject<T | null>,
  px: number,
): boolean {
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Border-box width, read the same way on mount and on every resize, so the
    // threshold compares against what the user sees rather than the content
    // box. A width of 0 is "not measured yet", not narrow.
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      setNarrow(w > 0 && w < px);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px]);

  return narrow;
}
