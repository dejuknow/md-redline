import { useEffect, useMemo, useState } from 'react';
import { pageGeometry, type PageGeometry } from '../lib/page-geometry';

/**
 * Observes the scroll container's content width and derives the page
 * geometry. `enabled` gates observation (rendered view only); `railAllowed`
 * carries the non-geometry rail conditions (visibility toggle, diff, focus).
 */
export function usePageGeometry(
  containerRef: React.RefObject<HTMLElement | null>,
  railAllowed: boolean,
  enabled: boolean,
): PageGeometry {
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cs = getComputedStyle(container);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      setContentWidth(container.clientWidth - pad);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();
    return () => ro.disconnect();
  }, [containerRef, enabled]);

  return useMemo(() => pageGeometry(contentWidth, railAllowed), [contentWidth, railAllowed]);
}
