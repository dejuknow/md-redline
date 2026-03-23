import { useCallback, useEffect, type RefObject } from 'react';

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

  useEffect(() => {
    resize();
  }, [value, resize]);

  return resize;
}
