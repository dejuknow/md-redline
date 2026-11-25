import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The rendered width of an element, kept current with a ResizeObserver.
 * Reads 0 until the first measurement, and stays 0 where ResizeObserver is
 * missing (jsdom), so callers should treat 0 as "not measured yet".
 */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Border-box width, read the same way on mount and on every resize, so a
    // threshold compares against what the user sees rather than the content box.
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
