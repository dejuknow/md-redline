import { useEffect, useRef } from 'react';
import { usePageVisible } from './usePageVisible';

interface Options {
  filePath: string | null;
  /**
   * `path` is the file the event is about, not whichever tab is active by the
   * time it lands. The callback is re-pointed on every render while the
   * EventSource is torn down in a passive effect cleanup, so an event queued
   * before a tab switch runs against the new tab's state.
   */
  onExternalChange: (content: string, mtime: number | undefined, path: string) => void;
}

/**
 * Connects to the server's SSE /api/watch endpoint for the active file.
 * Calls onExternalChange when the file is modified externally (not by our own saves).
 *
 * Closes the connection when the browser tab is hidden to avoid exhausting
 * the per-origin connection limit across multiple browser tabs.
 */
export function useFileWatcher({ filePath, onExternalChange }: Options) {
  const callbackRef = useRef(onExternalChange);
  callbackRef.current = onExternalChange;

  const visible = usePageVisible();

  useEffect(() => {
    if (!filePath || !visible) return;

    const url = `/api/watch?path=${encodeURIComponent(filePath)}`;
    const es = new EventSource(url);

    es.addEventListener('change', (e) => {
      try {
        const { content, mtime, path } = JSON.parse(e.data);
        callbackRef.current(content, mtime, typeof path === 'string' ? path : filePath);
      } catch {
        // Ignore malformed events
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    };

    return () => {
      es.close();
    };
  }, [filePath, visible]);
}
