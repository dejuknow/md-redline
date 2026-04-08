import { useState, useCallback, useMemo, useRef } from 'react';
import { getApiErrorMessage, readJsonResponse, type ApiErrorPayload } from '../lib/http';

export interface TabState {
  filePath: string;
  rawMarkdown: string;
  isLoading: boolean;
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  lastSaved: Date | null;
  /** Server-reported mtime (ms since epoch) for conflict detection */
  mtime?: number;
  /** True when local content has not yet been successfully saved to disk */
  dirty?: boolean;
}

interface PendingTabUpdate {
  tabData: Map<string, TabState>;
  tabOrder: string[];
  activeFilePath: string | null;
}

function findTabKey(tabData: Map<string, TabState>, path: string): string | null {
  if (tabData.has(path)) return path;
  for (const [key, tab] of tabData) {
    if (tab.filePath === path) return key;
  }
  return null;
}

export function isAccessDeniedError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Access denied');
}

export function findAccessDeniedTabs(tabData: Map<string, TabState>): string[] {
  const out: string[] = [];
  for (const [, tab] of tabData) {
    if (tab.errorKind === 'access-denied') out.push(tab.filePath);
  }
  return out;
}

interface LoadedTabUpdate {
  tabData: Map<string, TabState>;
  tabOrder: string[];
  activeFilePath: string | null;
}

type FileResponse = {
  path: string;
  content: string;
  mtime?: number;
} & ApiErrorPayload;

type SaveFileResponse = {
  success: boolean;
  path: string;
  mtime?: number;
} & ApiErrorPayload;

type ConflictResponse = {
  error: string;
  code: 'CONFLICT';
  currentContent: string;
  mtime: number;
} & ApiErrorPayload;

export function applyPendingTabState(
  prevData: Map<string, TabState>,
  prevOrder: string[],
  prevActiveFilePath: string | null,
  path: string,
  activate: boolean,
): PendingTabUpdate {
  const nextData = new Map(prevData);
  nextData.set(path, {
    filePath: path,
    rawMarkdown: '',
    isLoading: true,
    error: null,
    errorKind: null,
    lastSaved: null,
  });
  return {
    tabData: nextData,
    tabOrder: [...prevOrder, path],
    activeFilePath: activate ? path : prevActiveFilePath,
  };
}

export function applyLoadedTabState(
  prevData: Map<string, TabState>,
  prevOrder: string[],
  prevActiveFilePath: string | null,
  requestedPath: string,
  loadedPath: string,
  content: string,
  savedAt: Date,
): LoadedTabUpdate {
  const nextData = new Map(prevData);
  const loadedTabState: TabState = {
    filePath: loadedPath,
    rawMarkdown: content,
    isLoading: false,
    error: null,
    errorKind: null,
    lastSaved: savedAt,
  };

  if (requestedPath === loadedPath) {
    nextData.set(loadedPath, loadedTabState);
    return {
      tabData: nextData,
      tabOrder: prevOrder,
      activeFilePath: prevActiveFilePath,
    };
  }

  const nextOrder = prevOrder.filter((path) => path !== requestedPath);
  const hasLoadedPath = nextData.has(loadedPath);

  nextData.delete(requestedPath);
  nextData.set(
    loadedPath,
    hasLoadedPath ? { ...nextData.get(loadedPath)!, ...loadedTabState } : loadedTabState,
  );

  if (!hasLoadedPath) {
    const requestedIndex = prevOrder.indexOf(requestedPath);
    nextOrder.splice(requestedIndex === -1 ? nextOrder.length : requestedIndex, 0, loadedPath);
  }

  return {
    tabData: nextData,
    tabOrder: nextOrder,
    activeFilePath: prevActiveFilePath === requestedPath ? loadedPath : prevActiveFilePath,
  };
}

export function useTabs(options?: { onSaveError?: (msg: string) => void }) {
  const onSaveError = options?.onSaveError;
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [tabData, setTabData] = useState<Map<string, TabState>>(new Map());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // Use refs to avoid closures depending on state (which changes every render)
  const tabDataRef = useRef(tabData);
  tabDataRef.current = tabData;
  const tabOrderRef = useRef(tabOrder);
  tabOrderRef.current = tabOrder;
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const loadRequestIdsRef = useRef(new Map<string, number>());
  const nextLoadRequestIdRef = useRef(1);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const setTabDataState = useCallback(
    (updater: Map<string, TabState> | ((prev: Map<string, TabState>) => Map<string, TabState>)) => {
      const next = typeof updater === 'function' ? updater(tabDataRef.current) : updater;
      tabDataRef.current = next;
      setTabData(next);
    },
    [],
  );

  const setTabOrderState = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    const next = typeof updater === 'function' ? updater(tabOrderRef.current) : updater;
    tabOrderRef.current = next;
    setTabOrder(next);
  }, []);

  const setActiveFilePathState = useCallback(
    (updater: string | null | ((prev: string | null) => string | null)) => {
      const next = typeof updater === 'function' ? updater(activeFilePathRef.current) : updater;
      activeFilePathRef.current = next;
      setActiveFilePath(next);
    },
    [],
  );

  const startLoadRequest = useCallback((path: string) => {
    const requestId = nextLoadRequestIdRef.current++;
    loadRequestIdsRef.current.set(path, requestId);
    return requestId;
  }, []);

  const isCurrentLoadRequest = useCallback((path: string, requestId: number) => {
    return loadRequestIdsRef.current.get(path) === requestId;
  }, []);

  const finishLoadRequest = useCallback((path: string, requestId: number) => {
    if (loadRequestIdsRef.current.get(path) === requestId) {
      loadRequestIdsRef.current.delete(path);
    }
  }, []);

  const cancelLoadRequest = useCallback((path: string) => {
    loadRequestIdsRef.current.delete(path);
    abortControllersRef.current.get(path)?.abort();
    abortControllersRef.current.delete(path);
  }, []);

  const updateTab = useCallback(
    (path: string, updates: Partial<TabState>) => {
      setTabDataState((prev) => {
        const next = new Map(prev);
        const tabKey = findTabKey(next, path);
        const existing = tabKey ? next.get(tabKey) : undefined;
        if (existing) {
          next.set(tabKey!, { ...existing, ...updates });
        }
        return next;
      });
    },
    [setTabDataState],
  );

  const applyLoadedResponse = useCallback(
    (requestedPath: string, loadedPath: string, content: string) => {
      const next = applyLoadedTabState(
        tabDataRef.current,
        tabOrderRef.current,
        activeFilePathRef.current,
        requestedPath,
        loadedPath,
        content,
        new Date(),
      );
      setTabDataState(next.tabData);
      setTabOrderState(next.tabOrder);
      setActiveFilePathState(next.activeFilePath);
    },
    [setActiveFilePathState, setTabDataState, setTabOrderState],
  );

  const openTab = useCallback(
    async (path: string) => {
      const existingPath = findTabKey(tabDataRef.current, path);
      // If already open, just switch to it
      if (existingPath) {
        setActiveFilePathState(existingPath);
        return;
      }

      const next = applyPendingTabState(
        tabDataRef.current,
        tabOrderRef.current,
        activeFilePathRef.current,
        path,
        true,
      );
      setTabDataState(next.tabData);
      setTabOrderState(next.tabOrder);
      setActiveFilePathState(next.activeFilePath);
      const requestId = startLoadRequest(path);
      abortControllersRef.current.get(path)?.abort();
      const controller = new AbortController();
      abortControllersRef.current.set(path, controller);

      // Fetch file content
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        });
        const data = await readJsonResponse<FileResponse>(res);
        if (!res.ok || !data) {
          throw new Error(getApiErrorMessage(res, data, 'Failed to load file'));
        }
        if (!isCurrentLoadRequest(path, requestId)) return;
        applyLoadedResponse(path, data.path, data.content);
        if (data.mtime != null) updateTab(data.path, { mtime: data.mtime });
        finishLoadRequest(path, requestId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isCurrentLoadRequest(path, requestId)) return;
        const errorKind: TabState['errorKind'] = isAccessDeniedError(err)
          ? 'access-denied'
          : 'generic';
        setTabDataState((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, {
              ...existing,
              isLoading: false,
              error: err instanceof Error ? err.message : 'Failed to load file',
              errorKind,
            });
          }
          return next;
        });
        finishLoadRequest(path, requestId);
      } finally {
        abortControllersRef.current.delete(path);
      }
    },
    [
      applyLoadedResponse,
      finishLoadRequest,
      isCurrentLoadRequest,
      setActiveFilePathState,
      setTabDataState,
      setTabOrderState,
      startLoadRequest,
      updateTab,
    ],
  );

  const openTabInBackground = useCallback(
    async (path: string) => {
      // If already open, do nothing (don't switch)
      if (findTabKey(tabDataRef.current, path)) return;

      const next = applyPendingTabState(
        tabDataRef.current,
        tabOrderRef.current,
        activeFilePathRef.current,
        path,
        false,
      );
      setTabDataState(next.tabData);
      setTabOrderState(next.tabOrder);
      const requestId = startLoadRequest(path);
      abortControllersRef.current.get(path)?.abort();
      const controller = new AbortController();
      abortControllersRef.current.set(path, controller);

      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        });
        const data = await readJsonResponse<FileResponse>(res);
        if (!res.ok || !data) {
          throw new Error(getApiErrorMessage(res, data, 'Failed to load file'));
        }
        if (!isCurrentLoadRequest(path, requestId)) return;
        applyLoadedResponse(path, data.path, data.content);
        if (data.mtime != null) updateTab(data.path, { mtime: data.mtime });
        finishLoadRequest(path, requestId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isCurrentLoadRequest(path, requestId)) return;
        const errorKind: TabState['errorKind'] = isAccessDeniedError(err)
          ? 'access-denied'
          : 'generic';
        setTabDataState((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, {
              ...existing,
              isLoading: false,
              error: err instanceof Error ? err.message : 'Failed to load file',
              errorKind,
            });
          }
          return next;
        });
        finishLoadRequest(path, requestId);
      } finally {
        abortControllersRef.current.delete(path);
      }
    },
    [
      applyLoadedResponse,
      finishLoadRequest,
      isCurrentLoadRequest,
      setTabDataState,
      setTabOrderState,
      startLoadRequest,
      updateTab,
    ],
  );

  const closeTab = useCallback(
    (path: string) => {
      const tabKey = findTabKey(tabDataRef.current, path) ?? path;
      cancelLoadRequest(tabKey);
      const currentOrder = tabOrderRef.current;
      const idx = currentOrder.indexOf(tabKey);
      const remaining = currentOrder.filter((p) => p !== tabKey);

      setTabOrderState(remaining);
      // If closing the active tab, switch to an adjacent one
      setActiveFilePathState((currentActive) => {
        if (tabKey !== currentActive) return currentActive;
        if (remaining.length === 0) return null;
        return remaining[Math.min(idx, remaining.length - 1)];
      });
      setTabDataState((prev) => {
        const next = new Map(prev);
        next.delete(tabKey);
        return next;
      });
    },
    [cancelLoadRequest, setActiveFilePathState, setTabDataState, setTabOrderState],
  );

  const closeOtherTabs = useCallback(
    (keepPath: string) => {
      const keepKey = findTabKey(tabDataRef.current, keepPath) ?? keepPath;
      for (const path of tabDataRef.current.keys()) {
        if (path !== keepKey) cancelLoadRequest(path);
      }
      setTabOrderState((prev) => prev.filter((p) => p === keepKey));
      setActiveFilePathState(keepKey);
      setTabDataState((prev) => {
        const next = new Map<string, TabState>();
        const kept = prev.get(keepKey);
        if (kept) next.set(keepKey, kept);
        return next;
      });
    },
    [cancelLoadRequest, setActiveFilePathState, setTabDataState, setTabOrderState],
  );

  const closeAllTabs = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    loadRequestIdsRef.current.clear();
    setTabOrderState([]);
    setTabDataState(new Map());
    setActiveFilePathState(null);
  }, [setActiveFilePathState, setTabDataState, setTabOrderState]);

  const closeTabsToRight = useCallback(
    (path: string) => {
      const currentOrder = tabOrderRef.current;
      const tabKey = findTabKey(tabDataRef.current, path) ?? path;
      const idx = currentOrder.indexOf(tabKey);
      if (idx === -1) return;

      const kept = currentOrder.slice(0, idx + 1);
      const removed = currentOrder.slice(idx + 1);

      setTabOrderState(kept);
      setActiveFilePathState((currentActive) => {
        if (currentActive && kept.includes(currentActive)) return currentActive;
        return tabKey;
      });
      if (removed.length > 0) {
        for (const removedPath of removed) cancelLoadRequest(removedPath);
        setTabDataState((prevData) => {
          const nextData = new Map(prevData);
          for (const p of removed) nextData.delete(p);
          return nextData;
        });
      }
    },
    [cancelLoadRequest, setActiveFilePathState, setTabDataState, setTabOrderState],
  );

  const switchTab = useCallback(
    (path: string) => {
      const existingPath = findTabKey(tabDataRef.current, path);
      if (existingPath) setActiveFilePathState(existingPath);
    },
    [setActiveFilePathState],
  );

  const activeTab = activeFilePath ? (tabData.get(activeFilePath) ?? null) : null;

  const tabs = useMemo(
    () => tabOrder.map((p) => tabData.get(p)).filter((t): t is TabState => !!t),
    [tabOrder, tabData],
  );

  // Active tab delegates
  const rawMarkdown = activeTab?.rawMarkdown ?? '';
  const isLoading = activeTab?.isLoading ?? false;
  const error = activeTab?.error ?? null;
  const errorKind = activeTab?.errorKind ?? null;
  const filePath = activeTab?.filePath ?? '';

  const isTabDirty = useCallback(
    (path: string): boolean => {
      const key = findTabKey(tabDataRef.current, path) ?? path;
      return tabDataRef.current.get(key)?.dirty === true;
    },
    [],
  );

  const setRawMarkdown = useCallback(
    (content: string) => {
      if (activeFilePath) updateTab(activeFilePath, { rawMarkdown: content, dirty: true });
    },
    [activeFilePath, updateTab],
  );

  const saveFileAt = useCallback(
    (path: string, content: string) => {
      // Queue saves so rapid edits don't race: each save waits for the
      // previous one to finish. Reading mtime from tabDataRef at execution time
      // is correct because the queue serializes saves, so save1's returned mtime
      // is already written to the ref before save2 runs. Saves to different
      // files share the same queue, which is fine — they don't race anyway.
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const currentMtime = tabDataRef.current.get(path)?.mtime;
        try {
          const res = await fetch('/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path,
              content,
              expectedMtime: currentMtime,
            }),
          });
          if (res.status === 409) {
            const conflict = await readJsonResponse<ConflictResponse>(res);
            const msg = conflict?.error || 'File was modified externally. Reload to see changes.';
            updateTab(path, { error: msg });
            onSaveError?.(msg);
            return;
          }
          const data = await readJsonResponse<SaveFileResponse>(res);
          if (!res.ok || !data) {
            throw new Error(getApiErrorMessage(res, data, 'Failed to save file'));
          }
          updateTab(path, {
            lastSaved: new Date(),
            error: null,
            mtime: data.mtime,
            dirty: false,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to save file';
          updateTab(path, { error: msg });
          onSaveError?.(msg);
        }
      });
    },
    [updateTab, onSaveError],
  );

  const saveFile = useCallback(
    (content: string) => {
      if (!activeFilePath) return;
      saveFileAt(activeFilePath, content);
    },
    [activeFilePath, saveFileAt],
  );

  const getTabSnapshot = useCallback((path: string): TabState | undefined => {
    return tabDataRef.current.get(path);
  }, []);

  const reloadFile = useCallback(async () => {
    if (!activeFilePath) return;
    updateTab(activeFilePath, { isLoading: true, error: null });
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(activeFilePath)}`);
      const data = await readJsonResponse<FileResponse>(res);
      if (!res.ok || !data) {
        throw new Error(getApiErrorMessage(res, data, 'Failed to reload file'));
      }
      updateTab(activeFilePath, {
        rawMarkdown: data.content,
        isLoading: false,
        lastSaved: new Date(),
        error: null,
        errorKind: null,
        mtime: data.mtime,
      });
    } catch (err) {
      updateTab(activeFilePath, {
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to reload file',
        errorKind: isAccessDeniedError(err) ? 'access-denied' : 'generic',
      });
    }
  }, [activeFilePath, updateTab]);

  const retryAllAccessDenied = useCallback(async () => {
    const paths = findAccessDeniedTabs(tabDataRef.current);
    for (const path of paths) {
      // Clear the error so the tab re-enters the loading state, then re-fetch
      // via the same code path used by openTab. We avoid calling openTab
      // directly because it short-circuits when the tab already exists; we
      // want to force a refetch.
      const requestId = startLoadRequest(path);
      abortControllersRef.current.get(path)?.abort();
      const controller = new AbortController();
      abortControllersRef.current.set(path, controller);
      updateTab(path, { isLoading: true, error: null, errorKind: null });
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        });
        const data = await readJsonResponse<FileResponse>(res);
        if (!res.ok || !data) {
          throw new Error(getApiErrorMessage(res, data, 'Failed to load file'));
        }
        if (!isCurrentLoadRequest(path, requestId)) continue;
        applyLoadedResponse(path, data.path, data.content);
        if (data.mtime != null) updateTab(data.path, { mtime: data.mtime });
        finishLoadRequest(path, requestId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') continue;
        if (!isCurrentLoadRequest(path, requestId)) continue;
        const errorKind: TabState['errorKind'] = isAccessDeniedError(err)
          ? 'access-denied'
          : 'generic';
        updateTab(path, {
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load file',
          errorKind,
        });
        finishLoadRequest(path, requestId);
      } finally {
        abortControllersRef.current.delete(path);
      }
    }
  }, [
    applyLoadedResponse,
    finishLoadRequest,
    isCurrentLoadRequest,
    startLoadRequest,
    updateTab,
  ]);

  return {
    tabs,
    activeTab,
    activeFilePath,
    filePath,
    rawMarkdown,
    setRawMarkdown,
    updateTab,
    isLoading,
    error,
    errorKind,
    isTabDirty,
    openTab,
    openTabInBackground,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    switchTab,
    saveFile,
    saveFileAt,
    getTabSnapshot,
    reloadFile,
    retryAllAccessDenied,
  };
}
