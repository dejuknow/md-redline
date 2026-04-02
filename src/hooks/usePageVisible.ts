import { useState, useEffect } from 'react';

/**
 * Returns true when the browser tab is visible.
 * SSE connections should be gated on this to avoid exhausting
 * the browser's per-origin HTTP/1.1 connection limit (6) when
 * multiple browser tabs point at the same server.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const handler = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  return visible;
}
