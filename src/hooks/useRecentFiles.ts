import { useState, useCallback, useEffect, useRef } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string; // ISO-8601
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const hasLocalMutationRef = useRef(false);

  // Hydrate from disk on mount. Disk is the source of truth.
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled || hasLocalMutationRef.current) return;
      if (prefs.recentFiles && Array.isArray(prefs.recentFiles)) {
        setRecentFiles(prefs.recentFiles as RecentFile[]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addRecentFile = useCallback((path: string) => {
    hasLocalMutationRef.current = true;
    setRecentFiles((prev) => {
      const name = getPathBasename(path) || path;
      const filtered = prev.filter((f) => f.path !== path);
      const next = [{ path, name, openedAt: new Date().toISOString() }, ...filtered].slice(
        0,
        MAX_RECENT,
      );
      void savePreferencesToDisk({ recentFiles: next });
      return next;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    hasLocalMutationRef.current = true;
    setRecentFiles([]);
    void savePreferencesToDisk({ recentFiles: [] });
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}
