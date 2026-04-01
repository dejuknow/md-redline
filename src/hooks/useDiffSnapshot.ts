import { useState, useCallback, useEffect, type RefObject } from 'react';
import type { ViewMode } from '../components/Toolbar';

const STORAGE_KEY = 'md-redline-snapshots';

export function useDiffSnapshot(
  activeFilePath: string | null,
  rawMarkdownRef: RefObject<string>,
  showToast: (msg: string) => void,
  viewMode: ViewMode,
  setViewMode: (v: ViewMode | ((prev: ViewMode) => ViewMode)) => void,
) {
  const [snapshots, setSnapshots] = useState<Map<string, string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch {
      return new Map();
    }
  });

  useEffect(() => {
    try {
      if (snapshots.size === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(snapshots)));
      }
    } catch { /* ignore quota errors */ }
  }, [snapshots]);

  const currentSnapshot = activeFilePath ? (snapshots.get(activeFilePath) ?? null) : null;

  const handleSnapshot = useCallback(
    (extraEntries?: Map<string, string>) => {
      if (!activeFilePath) return;
      setSnapshots((prev) => {
        const next = new Map(prev);
        next.set(activeFilePath, rawMarkdownRef.current);
        if (extraEntries) {
          for (const [path, content] of extraEntries) {
            next.set(path, content);
          }
        }
        return next;
      });
      const isUpdate = snapshots.has(activeFilePath);
      showToast(isUpdate ? 'Snapshot updated' : 'Snapshot saved — diff view will show changes');
    },
    [activeFilePath, snapshots, showToast, rawMarkdownRef],
  );

  const handleClearSnapshot = useCallback(() => {
    if (!activeFilePath) return;
    setSnapshots((prev) => {
      const next = new Map(prev);
      next.delete(activeFilePath);
      return next;
    });
    if (viewMode === 'diff') setViewMode('rendered');
    showToast('Snapshot cleared');
  }, [activeFilePath, viewMode, setViewMode, showToast]);

  return { currentSnapshot, handleSnapshot, handleClearSnapshot };
}
