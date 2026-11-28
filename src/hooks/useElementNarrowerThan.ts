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
  /** 'content' leaves out the element's horizontal padding, for an element
   * whose padding is space its children cannot use. */
  box: 'border' | 'content' = 'border',
): boolean {
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Read the same way on mount and on every resize. By default the border
    // box, so the threshold compares against what the user sees; with 'content',
    // less the horizontal padding. A border box of 0 is "not measured yet",
    // not narrow; a laid-out element whose padding leaves no content is.
    const measure = () => {
      const border = el.getBoundingClientRect().width;
      let w = border;
      if (box === 'content') {
        const style = getComputedStyle(el);
        w -= (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      }
      setNarrow(border > 0 && w < px);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px, box]);

  return narrow;
}
