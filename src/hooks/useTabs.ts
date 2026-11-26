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

export type SaveState = 'saving' | 'saved' | 'failed';

/**
 * Whether a tab's latest edit is on disk. A handoff gates on this, since the
 * agent reads the file, not the tab: a comment still saving, or one whose
 * write failed (a conflict, a server error), would be missing from what the
 * agent sees. A load error is not a failed save; nothing local is unwritten.
 */
export function saveStateOf(tab: TabState | undefined, pendingSaves: number): SaveState {
  if (pendingSaves > 0) return 'saving';
  if (tab?.dirty && tab.error) return 'failed';
  return 'saved';
}

/** How many closed tabs Reopen Closed Tab remembers. */
export const MAX_CLOSED_TABS = 20;

/** A closed tab Reopen Closed Tab can bring back, at the index it had. */
export interface ClosedTab {
  path: string;
  index: number;
}

/**
 * Puts tabs just closed at the front of the closed list, newest first. A path
 * already in the list keeps only its newest entry, and the list keeps the
 * MAX_CLOSED_TABS most recent.
 */
export function recordClosedTabs(prev: ClosedTab[], closedNewestFirst: ClosedTab[]): ClosedTab[] {
  if (closedNewestFirst.length === 0) return prev;
  const closedPaths = new Set(closedNewestFirst.map((t) => t.path));
  return [...closedNewestFirst, ...prev.filter((t) => !closedPaths.has(t.path))].slice(
    0,
    MAX_CLOSED_TABS,
  );
}

/**
 * The closed-list entries for a batch close, given the removed tabs' paths and
 * original indices in strip order. The leftmost counts as newest, so repeated
 * reopens bring them back in ascending index order and each one lands back in
 * its old slot.
 */
function batchClosedTabs(order: string[], removed: (path: string) => boolean): ClosedTab[] {
  const out: ClosedTab[] = [];
  order.forEach((path, index) => {
    if (removed(path)) out.push({ path, index });
  });
  return out;
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
  /** Where to insert the tab, clamped to the strip; appends when omitted. */
  index?: number,
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
  const nextOrder = [...prevOrder];
  const at =
    index === undefined ? nextOrder.length : Math.max(0, Math.min(index, nextOrder.length));
  nextOrder.splice(at, 0, path);
  return {
    tabData: nextData,
    tabOrder: nextOrder,
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

export function useTabs(options?: {
  onSaveError?: (msg: string) => void;
  /**
   * Applied to content that arrives from disk on an explicit reload, before it
   * lands in the tab. Reload is a third way external content reaches a tab
   * (alongside the two watchers), so it has to run the same arriving-reply
   * bookkeeping. Returns the content to store.
   */
  onExternalContent?: (
    path: string,
    priorContent: string,
    content: string,
    mtime?: number,
  ) => string;
  /**
   * Fired when the server resolves the path we asked for into a different real
   * path, so state keyed by the requested path can move with the tab.
   */
  onPathResolved?: (requestedPath: string, loadedPath: string) => void;
}) {
  const onSaveError = options?.onSaveError;
  // Held in refs so a caller passing inline callbacks doesn't churn the
  // identity of every callback below them.
  const onExternalContentRef = useRef(options?.onExternalContent);
  onExternalContentRef.current = options?.onExternalContent;
  const onPathResolvedRef = useRef(options?.onPathResolved);
  onPathResolvedRef.current = options?.onPathResolved;
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [tabData, setTabData] = useState<Map<string, TabState>>(new Map());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // Recently closed tabs, newest first. In memory only: a reload forgets them.
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);

  // Use refs to avoid closures depending on state (which changes every render)
  const tabDataRef = useRef(tabData);
  tabDataRef.current = tabData;
  const tabOrderRef = useRef(tabOrder);
  tabOrderRef.current = tabOrder;
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const closedTabsRef = useRef(closedTabs);
  closedTabsRef.current = closedTabs;
  const loadRequestIdsRef = useRef(new Map<string, number>());
  const nextLoadRequestIdRef = useRef(1);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Writes queued or in flight per path, for getSaveState. Counted rather
  // than flagged because the queue can hold several writes for one file.
  const pendingSavesRef = useRef(new Map<string, number>());

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

  const setClosedTabsState = useCallback((next: ClosedTab[]) => {
    closedTabsRef.current = next;
    setClosedTabs(next);
  }, []);

  const rememberClosedTabs = useCallback(
    (closedNewestFirst: ClosedTab[]) => {
      setClosedTabsState(recordClosedTabs(closedTabsRef.current, closedNewestFirst));
    },
    [setClosedTabsState],
  );

  // A path opened again by any route is no longer closed. Without this, its
  // entry would make Reopen Closed Tab spend a press switching to a tab that
  // is already there, and keep offering a reopen with nothing behind it.
  const forgetClosedTab = useCallback(
    (path: string) => {
      const prev = closedTabsRef.current;
      if (prev.some((t) => t.path === path)) {
        setClosedTabsState(prev.filter((t) => t.path !== path));
      }
    },
    [setClosedTabsState],
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
      if (requestedPath !== loadedPath) {
        onPathResolvedRef.current?.(requestedPath, loadedPath);
        forgetClosedTab(loadedPath);
      }
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
    [forgetClosedTab, setActiveFilePathState, setTabDataState, setTabOrderState],
  );

  const openTabAt = useCallback(
    async (path: string, index?: number) => {
      forgetClosedTab(path);
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
        index,
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
        // Compare-and-delete: only clear the slot if it still holds OUR
        // controller. A racing openTab(samePath) may have already installed
        // a fresh controller — deleting it here would orphan that load.
        if (abortControllersRef.current.get(path) === controller) {
          abortControllersRef.current.delete(path);
        }
      }
    },
    [
      applyLoadedResponse,
      finishLoadRequest,
      forgetClosedTab,
      isCurrentLoadRequest,
      setActiveFilePathState,
      setTabDataState,
      setTabOrderState,
      startLoadRequest,
      updateTab,
    ],
  );

  const openTab = useCallback((path: string) => openTabAt(path), [openTabAt]);

  const openTabInBackground = useCallback(
    async (path: string) => {
      forgetClosedTab(path);
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
        if (abortControllersRef.current.get(path) === controller) {
          abortControllersRef.current.delete(path);
        }
      }
    },
    [
      applyLoadedResponse,
      finishLoadRequest,
      forgetClosedTab,
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
      if (idx !== -1) rememberClosedTabs([{ path: tabKey, index: idx }]);

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
    [
      cancelLoadRequest,
      rememberClosedTabs,
      setActiveFilePathState,
      setTabDataState,
      setTabOrderState,
    ],
  );

  const closeOtherTabs = useCallback(
    (keepPath: string) => {
      const keepKey = findTabKey(tabDataRef.current, keepPath) ?? keepPath;
      rememberClosedTabs(batchClosedTabs(tabOrderRef.current, (p) => p !== keepKey));
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
    [
      cancelLoadRequest,
      rememberClosedTabs,
      setActiveFilePathState,
      setTabDataState,
      setTabOrderState,
    ],
  );

  const closeAllTabs = useCallback(() => {
    rememberClosedTabs(batchClosedTabs(tabOrderRef.current, () => true));
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    loadRequestIdsRef.current.clear();
    setTabOrderState([]);
    setTabDataState(new Map());
    setActiveFilePathState(null);
  }, [rememberClosedTabs, setActiveFilePathState, setTabDataState, setTabOrderState]);

  const closeTabsToRight = useCallback(
    (path: string) => {
      const currentOrder = tabOrderRef.current;
      const tabKey = findTabKey(tabDataRef.current, path) ?? path;
      const idx = currentOrder.indexOf(tabKey);
      if (idx === -1) return;

      const kept = currentOrder.slice(0, idx + 1);
      const removed = currentOrder.slice(idx + 1);
      rememberClosedTabs(removed.map((p, i) => ({ path: p, index: idx + 1 + i })));

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
    [
      cancelLoadRequest,
      rememberClosedTabs,
      setActiveFilePathState,
      setTabDataState,
      setTabOrderState,
    ],
  );

  /**
   * Brings back the most recently closed tab at the index it had (clamped to
   * the strip) and activates it. Opening a path by any other route drops its
   * entry, so the switch openTabAt does for an open path is only a fallback
   * (two spellings of one file). A batch close comes back one tab per call. Returns false when
   * there is nothing to reopen. A file deleted since it closed loads into the
   * same error state as any missing file.
   */
  const reopenClosedTab = useCallback((): boolean => {
    const [entry, ...rest] = closedTabsRef.current;
    if (!entry) return false;
    setClosedTabsState(rest);
    void openTabAt(entry.path, entry.index);
    return true;
  }, [openTabAt, setClosedTabsState]);

  const canReopenClosedTab = closedTabs.length > 0;
  /** canReopenClosedTab read live, for callers outside a render. */
  const hasClosedTab = useCallback(() => closedTabsRef.current.length > 0, []);

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

  const isTabDirty = useCallback((path: string): boolean => {
    const key = findTabKey(tabDataRef.current, path) ?? path;
    return tabDataRef.current.get(key)?.dirty === true;
  }, []);

  const setRawMarkdown = useCallback(
    (content: string) => {
      // Read the active file path from a ref so this callback always sees
      // the current tab — not the tab that was active when the callback
      // was last memoized. Without this, Cmd-Tabbing while typing can
      // route an edit into the previously-active tab.
      const current = activeFilePathRef.current;
      if (current) updateTab(current, { rawMarkdown: content, dirty: true });
    },
    [updateTab],
  );

  const saveFileAt = useCallback(
    (path: string, content: string) => {
      // Queue saves so rapid edits don't race: each save waits for the
      // previous one to finish. Reading mtime from tabDataRef at execution time
      // is correct because the queue serializes saves, so save1's returned mtime
      // is already written to the ref before save2 runs. Saves to different
      // files share the same queue, which is fine — they don't race anyway.
      const pending = pendingSavesRef.current;
      pending.set(path, (pending.get(path) ?? 0) + 1);
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
          // A newer write for this file is still queued, so the tab holds
          // text this one did not carry: it stays dirty until that write
          // lands. Clearing it here let a failure of the newer write read as
          // saved, since a failure only sets `error`.
          const newerWriteQueued = (pending.get(path) ?? 0) > 1;
          updateTab(path, {
            lastSaved: new Date(),
            error: null,
            mtime: data.mtime,
            ...(newerWriteQueued ? {} : { dirty: false }),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to save file';
          updateTab(path, { error: msg });
          onSaveError?.(msg);
        } finally {
          const left = (pending.get(path) ?? 1) - 1;
          if (left > 0) pending.set(path, left);
          else pending.delete(path);
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

  const getSaveState = useCallback((path: string): SaveState => {
    const key = findTabKey(tabDataRef.current, path) ?? path;
    const pending = pendingSavesRef.current;
    const pendingSaves = (pending.get(key) ?? 0) + (key === path ? 0 : (pending.get(path) ?? 0));
    return saveStateOf(tabDataRef.current.get(key), pendingSaves);
  }, []);

  /** Settles once every write queued so far has finished, failed or not. */
  const whenSaved = useCallback((): Promise<void> => saveQueueRef.current, []);

  const getTabSnapshot = useCallback((path: string): TabState | undefined => {
    return tabDataRef.current.get(path);
  }, []);

  const reloadFile = useCallback(async () => {
    if (!activeFilePath) return;
    updateTab(activeFilePath, { isLoading: true, error: null });
    try {
      const priorContent = tabDataRef.current.get(activeFilePath)?.rawMarkdown ?? '';
      const res = await fetch(`/api/file?path=${encodeURIComponent(activeFilePath)}`);
      const data = await readJsonResponse<FileResponse>(res);
      if (!res.ok || !data) {
        throw new Error(getApiErrorMessage(res, data, 'Failed to reload file'));
      }
      // A reply can reach the client for the first time here: the tab was
      // hidden, and both the SSE stream and the visibility-restore fetch
      // missed it. Without this hook that reply would never be marked unread.
      const content =
        onExternalContentRef.current?.(activeFilePath, priorContent, data.content, data.mtime) ??
        data.content;
      updateTab(activeFilePath, {
        rawMarkdown: content,
        isLoading: false,
        lastSaved: new Date(),
        error: null,
        errorKind: null,
        mtime: data.mtime,
        // The tab now shows what is on disk, so nothing local is unsaved. A
        // stale flag would make a later load error read as a failed save.
        dirty: false,
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
        if (abortControllersRef.current.get(path) === controller) {
          abortControllersRef.current.delete(path);
        }
      }
    }
  }, [applyLoadedResponse, finishLoadRequest, isCurrentLoadRequest, startLoadRequest, updateTab]);

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
    reopenClosedTab,
    canReopenClosedTab,
    hasClosedTab,
    switchTab,
    saveFile,
    saveFileAt,
    getSaveState,
    whenSaved,
    getTabSnapshot,
    reloadFile,
    retryAllAccessDenied,
  };
}
