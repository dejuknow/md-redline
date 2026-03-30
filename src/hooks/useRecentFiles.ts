import { useState, useCallback, useEffect } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

const STORAGE_KEY = 'md-redline-recent-files';
const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string; // ISO-8601
}

function loadFromStorage(): RecentFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(files: RecentFile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch { /* Storage unavailable */ }
  savePreferencesToDisk({ recentFiles: files });
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(loadFromStorage);

  // Hydrate from disk on mount
  useEffect(() => {
    fetchPreferences().then((prefs) => {
      if (prefs.recentFiles && Array.isArray(prefs.recentFiles) && prefs.recentFiles.length > 0) {
        setRecentFiles(prefs.recentFiles as RecentFile[]);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs.recentFiles)); } catch {}
      }
    });
  }, []);

  const addRecentFile = useCallback((path: string) => {
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
    setRecentFiles([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    savePreferencesToDisk({ recentFiles: [] });
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}
