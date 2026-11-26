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

  // Several at once (a drop of files on the desktop app) in one update and
  // one save, the first one newest: one save per file could reach the server
  // out of order and leave a shorter list on disk.
  const addRecentFiles = useCallback((paths: string[]) => {
    const fresh = [...new Set(paths)];
    if (fresh.length === 0) return;
    hasLocalMutationRef.current = true;
    setRecentFiles((prev) => {
      const openedAt = new Date().toISOString();
      const added = fresh.map((path) => ({ path, name: getPathBasename(path) || path, openedAt }));
      const next = [...added, ...prev.filter((f) => !fresh.includes(f.path))].slice(0, MAX_RECENT);
      void savePreferencesToDisk({ recentFiles: next });
      return next;
    });
  }, []);

  const addRecentFile = useCallback((path: string) => addRecentFiles([path]), [addRecentFiles]);

  const clearRecentFiles = useCallback(() => {
    hasLocalMutationRef.current = true;
    setRecentFiles([]);
    void savePreferencesToDisk({ recentFiles: [] });
  }, []);

  return { recentFiles, addRecentFile, addRecentFiles, clearRecentFiles };
}
