import { useState, useCallback } from 'react';
import { getPathBasename } from '../lib/path-utils';

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(loadFromStorage);

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
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}
