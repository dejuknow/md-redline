import { useEffect, useRef } from 'react';

interface Options {
  filePath: string | null;
  onExternalChange: (content: string) => void;
}

/**
 * Connects to the server's SSE /api/watch endpoint for the active file.
 * Calls onExternalChange when the file is modified externally (not by our own saves).
 */
export function useFileWatcher({ filePath, onExternalChange }: Options) {
  const callbackRef = useRef(onExternalChange);
  callbackRef.current = onExternalChange;

  useEffect(() => {
    if (!filePath) return;

    const url = `/api/watch?path=${encodeURIComponent(filePath)}`;
    const es = new EventSource(url);

    es.addEventListener('change', (e) => {
      try {
        const { content } = JSON.parse(e.data);
        callbackRef.current(content);
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
  }, [filePath]);
}
