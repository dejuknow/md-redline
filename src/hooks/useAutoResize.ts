import { useCallback, useLayoutEffect, type RefObject } from 'react';

/**
 * Auto-resizes a textarea to fit its content.
 * Call `trigger` after programmatic value changes (e.g. template insert).
 */
export function useAutoResize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref]);

  // A layout effect, so the new height lands before paint and before any
  // layout effect declared after this hook measures the surrounding surface.
  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  return resize;
}
