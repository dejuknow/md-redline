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
  /**
   * Stay connected while the page is hidden. The desktop app sets it while
   * agent notifications are on (#244): one window, so no connection limit
   * to share, and the hidden window is when replies need noticing.
   */
  keepWhileHidden?: boolean;
  /**
   * The connection dropped and came back. The server answers a reconnect
   * with "connected" only, so a change made in the gap has to be read.
   */
  onReconnect?: (path: string) => void;
}

/**
 * Connects to the server's SSE /api/watch endpoint for the active file.
 * Calls onExternalChange when the file is modified externally (not by our own saves).
 *
 * Closes the connection when the browser tab is hidden to avoid exhausting
 * the per-origin connection limit across multiple browser tabs, unless
 * `keepWhileHidden`.
 */
export function useFileWatcher({
  filePath,
  onExternalChange,
  keepWhileHidden = false,
  onReconnect,
}: Options) {
  const callbackRef = useRef(onExternalChange);
  callbackRef.current = onExternalChange;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  const visible = usePageVisible();
  const connected = visible || keepWhileHidden;

  useEffect(() => {
    if (!filePath || !connected) return;

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

    let dropped = false;
    es.onerror = () => {
      // EventSource reconnects by itself; what changed meanwhile is read
      // once it is back.
      dropped = true;
    };
    es.addEventListener('connected', () => {
      if (!dropped) return;
      dropped = false;
      reconnectRef.current?.(filePath);
    });

    return () => {
      es.close();
    };
  }, [filePath, connected]);
}
