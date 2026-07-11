import { useEffect, useMemo, useState } from 'react';
import { pageGeometry, type PageGeometry, CANVAS_GUTTER, COL_MAX } from '../lib/page-geometry';

/**
 * Observes the scroll container's content width and derives the page
 * geometry. `enabled` gates observation (rendered view only); `railAllowed`
 * carries the non-geometry rail conditions (visibility toggle, diff, focus).
 * Accounts for the canvas gutter in the available width so max-width constraints
 * on the page element never clip the rail gap.
 */
export function usePageGeometry(
  containerRef: React.RefObject<HTMLElement | null>,
  railAllowed: boolean,
  enabled: boolean,
  colMax: number = COL_MAX,
): PageGeometry {
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setContentWidth(0);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cs = getComputedStyle(container);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      setContentWidth(Math.max(container.clientWidth - pad - CANVAS_GUTTER, 0));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();
    return () => ro.disconnect();
  }, [containerRef, enabled]);

  return useMemo(
    () => pageGeometry(contentWidth, railAllowed, colMax),
    [contentWidth, railAllowed, colMax],
  );
}
