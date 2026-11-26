import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Whether a row's labeled buttons fit beside its other children, measured
 * rather than guessed from a width breakpoint. The sidebar's Explorer and
 * Outline switch used a container query for this, and inside the desktop
 * app's zoomed WKWebView it let the labels show in a row too narrow for them,
 * wrapping each label under its icon.
 *
 * `group` holds the labeled buttons (which must not wrap their text) and is a
 * child of the row, which is attached through the returned callback ref (the
 * row mounts and unmounts with its panel).
 *
 * Both directions compare the same two numbers: the room the row leaves the
 * group (its content box less its other children, which do not change with
 * the labels) and the group's labeled width (measured from its buttons while
 * labeled, remembered while compact). An earlier version decided "too narrow"
 * from the group overflowing (scrollWidth) and "fits again" from the room; in
 * the zoomed WKWebView the two disagreed at some widths, each undid the other,
 * and React gave up on the endless re-render and blanked the window.
 */
export function useLabelsFit(
  group: RefObject<HTMLElement | null>,
): [fits: boolean, rowRef: (el: HTMLElement | null) => void] {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  const fitsRef = useRef(fits);
  fitsRef.current = fits;
  const labeledWidth = useRef(0);

  const check = useCallback(() => {
    const groupEl = group.current;
    if (!row || !groupEl) return;
    const style = getComputedStyle(row);
    const gap = parseFloat(style.columnGap) || 0;
    let others = 0;
    for (const child of Array.from(row.children)) {
      if (child !== groupEl) others += child.getBoundingClientRect().width + gap;
    }
    const room =
      row.getBoundingClientRect().width -
      (parseFloat(style.borderLeftWidth) || 0) -
      (parseFloat(style.borderRightWidth) || 0) -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) -
      others;
    if (fitsRef.current) {
      // The buttons keep their full width when the group is squeezed (their
      // text does not wrap), so first to last spans the labeled width.
      const buttons = groupEl.children;
      if (buttons.length === 0) return;
      labeledWidth.current =
        buttons[buttons.length - 1].getBoundingClientRect().right -
        buttons[0].getBoundingClientRect().left;
    }
    const next = room + 0.5 >= labeledWidth.current;
    if (next !== fitsRef.current) setFits(next);
  }, [row, group]);

  // Re-check after every switch too: a newly labeled group is measured afresh.
  useLayoutEffect(() => {
    check();
  }, [check, fits]);

  // Watches the content box: a window inset that comes or goes changes the
  // row's padding, not its outer size. A newly mounted row starts labeled
  // and is measured afresh.
  useLayoutEffect(() => {
    if (!row || typeof ResizeObserver === 'undefined') return;
    setFits(true);
    const observer = new ResizeObserver(() => check());
    observer.observe(row);
    return () => observer.disconnect();
  }, [row, check]);

  return [fits, setRow];
}
