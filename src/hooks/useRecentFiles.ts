import { useState, useCallback, useEffect, useRef } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

const STORAGE_KEY = 'md-redline-recent-files';
const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string; // ISO-8601
}

export function mergeRecentFiles(primary: RecentFile[], secondary: RecentFile[]): RecentFile[] {
  const byPath = new Map<string, RecentFile>();

  for (const file of [...primary, ...secondary]) {
    const existing = byPath.get(file.path);
    if (!existing || file.openedAt > existing.openedAt) {
      byPath.set(file.path, file);
    }
  }

  return Array.from(byPath.values())
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .slice(0, MAX_RECENT);
}

export function loadFromStorage(): RecentFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveToStorage(files: RecentFile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch {
    /* Storage unavailable */
  }
  savePreferencesToDisk({ recentFiles: files });
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(loadFromStorage);
  const hasLocalMutationRef = useRef(false);

  // Hydrate from disk on mount
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled || hasLocalMutationRef.current) return;
      if (prefs.recentFiles && Array.isArray(prefs.recentFiles) && prefs.recentFiles.length > 0) {
        setRecentFiles((prev) => {
          const next = mergeRecentFiles(prev, prefs.recentFiles as RecentFile[]);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            /* storage unavailable */
          }
          return next;
        });
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
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    hasLocalMutationRef.current = true;
    setRecentFiles([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    savePreferencesToDisk({ recentFiles: [] });
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}
