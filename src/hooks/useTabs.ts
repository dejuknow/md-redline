import { useState, useCallback, useMemo, useRef } from 'react';

interface TabState {
  filePath: string;
  rawMarkdown: string;
  isLoading: boolean;
  error: string | null;
  lastSaved: Date | null;
}

export function useTabs() {
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [tabData, setTabData] = useState<Map<string, TabState>>(new Map());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // Use ref to avoid openTab depending on tabData (which changes every render)
  const tabDataRef = useRef(tabData);
  tabDataRef.current = tabData;

  const updateTab = useCallback((path: string, updates: Partial<TabState>) => {
    setTabData((prev) => {
      const next = new Map(prev);
      const existing = next.get(path);
      if (existing) {
        next.set(path, { ...existing, ...updates });
      }
      return next;
    });
  }, []);

  const openTab = useCallback(
    async (path: string) => {
      // If already open, just switch to it
      if (tabDataRef.current.has(path)) {
        setActiveFilePath(path);
        return;
      }

      // Create placeholder tab and activate it
      const newTab: TabState = {
        filePath: path,
        rawMarkdown: '',
        isLoading: true,
        error: null,
        lastSaved: null,
      };
      setTabData((prev) => new Map(prev).set(path, newTab));
      setTabOrder((prev) => [...prev, path]);
      setActiveFilePath(path);

      // Fetch file content
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setTabData((prev) => {
          const next = new Map(prev);
          next.set(path, {
            filePath: data.path,
            rawMarkdown: data.content,
            isLoading: false,
            error: null,
            lastSaved: new Date(),
          });
          return next;
        });
      } catch (err) {
        setTabData((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, {
              ...existing,
              isLoading: false,
              error: err instanceof Error ? err.message : 'Failed to load file',
            });
          }
          return next;
        });
      }
    },
    []
  );

  const closeTab = useCallback(
    (path: string) => {
      setTabOrder((prev) => {
        const idx = prev.indexOf(path);
        const next = prev.filter((p) => p !== path);

        // If closing the active tab, switch to an adjacent one
        setActiveFilePath((currentActive) => {
          if (path !== currentActive) return currentActive;
          if (next.length === 0) return null;
          return next[Math.min(idx, next.length - 1)];
        });

        return next;
      });
      setTabData((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
    },
    []
  );

  const switchTab = useCallback((path: string) => {
    setActiveFilePath(path);
  }, []);

  const activeTab = activeFilePath ? tabData.get(activeFilePath) ?? null : null;

  const tabs = useMemo(
    () => tabOrder.map((p) => tabData.get(p)).filter((t): t is TabState => !!t),
    [tabOrder, tabData]
  );

  // Active tab delegates
  const rawMarkdown = activeTab?.rawMarkdown ?? '';
  const isLoading = activeTab?.isLoading ?? false;
  const error = activeTab?.error ?? null;
  const lastSaved = activeTab?.lastSaved ?? null;
  const filePath = activeTab?.filePath ?? '';

  const setRawMarkdown = useCallback(
    (content: string) => {
      if (activeFilePath) updateTab(activeFilePath, { rawMarkdown: content });
    },
    [activeFilePath, updateTab]
  );

  const saveFile = useCallback(
    async (content: string) => {
      if (!activeFilePath) return;
      try {
        const res = await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: activeFilePath, content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        updateTab(activeFilePath, { lastSaved: new Date(), error: null });
      } catch (err) {
        updateTab(activeFilePath, {
          error: err instanceof Error ? err.message : 'Failed to save file',
        });
      }
    },
    [activeFilePath, updateTab]
  );

  const reloadFile = useCallback(async () => {
    if (!activeFilePath) return;
    updateTab(activeFilePath, { isLoading: true, error: null });
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(activeFilePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      updateTab(activeFilePath, {
        rawMarkdown: data.content,
        isLoading: false,
        lastSaved: new Date(),
        error: null,
      });
    } catch (err) {
      updateTab(activeFilePath, {
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to reload file',
      });
    }
  }, [activeFilePath, updateTab]);

  return {
    tabs,
    activeTab,
    activeFilePath,
    filePath,
    rawMarkdown,
    setRawMarkdown,
    isLoading,
    error,
    lastSaved,
    openTab,
    closeTab,
    switchTab,
    saveFile,
    reloadFile,
  };
}
