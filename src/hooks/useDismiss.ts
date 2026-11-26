import { useEffect } from 'react';

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-overlay]';

/**
 * Closes a popup on a press outside `ref`, on focus moving outside it (a
 * palette or find bar opened by keyboard takes the focus), or on Escape.
 * Escape is caught on the way down and stopped there, so App's own Escape
 * handling never sees it, unless another overlay is open (a dialog, or the
 * command palette, which marks itself `data-overlay`): that Escape is the
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
      const otherOverlay = Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some((el) =>
        outside(el),
      );
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
