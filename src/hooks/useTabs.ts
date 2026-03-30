import { useState, useCallback, useMemo, useRef } from 'react';

export interface TabState {
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

  // Use refs to avoid closures depending on state (which changes every render)
  const tabDataRef = useRef(tabData);
  tabDataRef.current = tabData;
  const tabOrderRef = useRef(tabOrder);
  tabOrderRef.current = tabOrder;
  const loadRequestIdsRef = useRef(new Map<string, number>());
  const nextLoadRequestIdRef = useRef(1);

  const startLoadRequest = useCallback((path: string) => {
    const requestId = nextLoadRequestIdRef.current++;
    loadRequestIdsRef.current.set(path, requestId);
    return requestId;
  }, []);

  const isCurrentLoadRequest = useCallback((path: string, requestId: number) => {
    return (
      loadRequestIdsRef.current.get(path) === requestId &&
      tabDataRef.current.has(path)
    );
  }, []);

  const finishLoadRequest = useCallback((path: string, requestId: number) => {
    if (loadRequestIdsRef.current.get(path) === requestId) {
      loadRequestIdsRef.current.delete(path);
    }
  }, []);

  const cancelLoadRequest = useCallback((path: string) => {
    loadRequestIdsRef.current.delete(path);
  }, []);

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

  const openTab = useCallback(async (path: string) => {
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
    const requestId = startLoadRequest(path);

    // Fetch file content
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!isCurrentLoadRequest(path, requestId)) return;
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
      finishLoadRequest(path, requestId);
    } catch (err) {
      if (!isCurrentLoadRequest(path, requestId)) return;
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
      finishLoadRequest(path, requestId);
    }
  }, [finishLoadRequest, isCurrentLoadRequest, startLoadRequest]);

  const openTabInBackground = useCallback(async (path: string) => {
    // If already open, do nothing (don't switch)
    if (tabDataRef.current.has(path)) return;

    const newTab: TabState = {
      filePath: path,
      rawMarkdown: '',
      isLoading: true,
      error: null,
      lastSaved: null,
    };
    setTabData((prev) => new Map(prev).set(path, newTab));
    setTabOrder((prev) => [...prev, path]);
    const requestId = startLoadRequest(path);

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!isCurrentLoadRequest(path, requestId)) return;
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
      finishLoadRequest(path, requestId);
    } catch (err) {
      if (!isCurrentLoadRequest(path, requestId)) return;
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
      finishLoadRequest(path, requestId);
    }
  }, [finishLoadRequest, isCurrentLoadRequest, startLoadRequest]);

  const closeTab = useCallback((path: string) => {
    cancelLoadRequest(path);
    const currentOrder = tabOrderRef.current;
    const idx = currentOrder.indexOf(path);
    const remaining = currentOrder.filter((p) => p !== path);

    setTabOrder(remaining);
    // If closing the active tab, switch to an adjacent one
    setActiveFilePath((currentActive) => {
      if (path !== currentActive) return currentActive;
      if (remaining.length === 0) return null;
      return remaining[Math.min(idx, remaining.length - 1)];
    });
    setTabData((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, [cancelLoadRequest]);

  const closeOtherTabs = useCallback((keepPath: string) => {
    for (const path of tabDataRef.current.keys()) {
      if (path !== keepPath) cancelLoadRequest(path);
    }
    setTabOrder((prev) => prev.filter((p) => p === keepPath));
    setActiveFilePath(keepPath);
    setTabData((prev) => {
      const next = new Map<string, TabState>();
      const kept = prev.get(keepPath);
      if (kept) next.set(keepPath, kept);
      return next;
    });
  }, [cancelLoadRequest]);

  const closeAllTabs = useCallback(() => {
    loadRequestIdsRef.current.clear();
    setTabOrder([]);
    setTabData(new Map());
    setActiveFilePath(null);
  }, []);

  const closeTabsToRight = useCallback((path: string) => {
    const currentOrder = tabOrderRef.current;
    const idx = currentOrder.indexOf(path);
    if (idx === -1) return;

    const kept = currentOrder.slice(0, idx + 1);
    const removed = currentOrder.slice(idx + 1);

    setTabOrder(kept);
    setActiveFilePath((currentActive) => {
      if (currentActive && kept.includes(currentActive)) return currentActive;
      return path;
    });
    if (removed.length > 0) {
      for (const removedPath of removed) cancelLoadRequest(removedPath);
      setTabData((prevData) => {
        const nextData = new Map(prevData);
        for (const p of removed) nextData.delete(p);
        return nextData;
      });
    }
  }, [cancelLoadRequest]);

  const switchTab = useCallback((path: string) => {
    setActiveFilePath(path);
  }, []);

  const activeTab = activeFilePath ? (tabData.get(activeFilePath) ?? null) : null;

  const tabs = useMemo(
    () => tabOrder.map((p) => tabData.get(p)).filter((t): t is TabState => !!t),
    [tabOrder, tabData],
  );

  // Active tab delegates
  const rawMarkdown = activeTab?.rawMarkdown ?? '';
  const isLoading = activeTab?.isLoading ?? false;
  const error = activeTab?.error ?? null;
  const filePath = activeTab?.filePath ?? '';

  const setRawMarkdown = useCallback(
    (content: string) => {
      if (activeFilePath) updateTab(activeFilePath, { rawMarkdown: content });
    },
    [activeFilePath, updateTab],
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
    [activeFilePath, updateTab],
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
    openTab,
    openTabInBackground,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    switchTab,
    saveFile,
    reloadFile,
  };
}
