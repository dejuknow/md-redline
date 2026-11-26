// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  applyLoadedTabState,
  applyPendingTabState,
  findAccessDeniedTabs,
  isAccessDeniedError,
  saveStateOf,
  useTabs,
  type TabState,
} from './useTabs';

function makeTab(path: string, overrides: Partial<TabState> = {}): TabState {
  return {
    filePath: path,
    rawMarkdown: '',
    isLoading: true,
    error: null,
    errorKind: null,
    lastSaved: null,
    ...overrides,
  };
}

describe('applyLoadedTabState', () => {
  it('migrates a requested tab to the canonical loaded path', () => {
    const requestedPath = '/tmp/link.md';
    const loadedPath = '/tmp/real.md';
    const prevData = new Map([[requestedPath, makeTab(requestedPath)]]);
    const result = applyLoadedTabState(
      prevData,
      [requestedPath],
      requestedPath,
      requestedPath,
      loadedPath,
      '# Loaded\n',
      new Date('2026-03-30T00:00:00.000Z'),
    );

    expect(result.tabOrder).toEqual([loadedPath]);
    expect(result.activeFilePath).toBe(loadedPath);
    expect(result.tabData.has(requestedPath)).toBe(false);
    expect(result.tabData.get(loadedPath)).toMatchObject({
      filePath: loadedPath,
      rawMarkdown: '# Loaded\n',
      isLoading: false,
      error: null,
    });
  });

  it('deduplicates when the canonical path is already open', () => {
    const requestedPath = '/tmp/link.md';
    const loadedPath = '/tmp/real.md';
    const prevData = new Map<string, TabState>([
      [loadedPath, makeTab(loadedPath, { rawMarkdown: '# Existing\n', isLoading: false })],
      [requestedPath, makeTab(requestedPath)],
    ]);
    const result = applyLoadedTabState(
      prevData,
      [loadedPath, requestedPath],
      requestedPath,
      requestedPath,
      loadedPath,
      '# Updated\n',
      new Date('2026-03-30T00:00:00.000Z'),
    );

    expect(result.tabOrder).toEqual([loadedPath]);
    expect(result.activeFilePath).toBe(loadedPath);
    expect(result.tabData.size).toBe(1);
    expect(result.tabData.get(loadedPath)?.rawMarkdown).toBe('# Updated\n');
  });
});

describe('applyPendingTabState', () => {
  it('preserves session-restore order and active tab for a fast load response', () => {
    const firstPath = '/tmp/first.md';
    const secondPath = '/tmp/second.md';
    const withBackgroundTab = applyPendingTabState(new Map(), [], null, firstPath, false);
    const withActiveTab = applyPendingTabState(
      withBackgroundTab.tabData,
      withBackgroundTab.tabOrder,
      withBackgroundTab.activeFilePath,
      secondPath,
      true,
    );

    const loaded = applyLoadedTabState(
      withActiveTab.tabData,
      withActiveTab.tabOrder,
      withActiveTab.activeFilePath,
      secondPath,
      secondPath,
      '# Second\n',
      new Date('2026-03-30T00:00:00.000Z'),
    );

    expect(loaded.tabOrder).toEqual([firstPath, secondPath]);
    expect(loaded.activeFilePath).toBe(secondPath);
    expect(loaded.tabData.get(secondPath)).toMatchObject({
      filePath: secondPath,
      rawMarkdown: '# Second\n',
      isLoading: false,
      error: null,
    });
  });
});

describe('applyPendingTabState — extended', () => {
  it('sets isLoading and empty markdown on new pending tab', () => {
    const path = '/tmp/new.md';
    const result = applyPendingTabState(new Map(), [], null, path, true);

    const tab = result.tabData.get(path)!;
    expect(tab.isLoading).toBe(true);
    expect(tab.rawMarkdown).toBe('');
    expect(tab.error).toBeNull();
    expect(tab.lastSaved).toBeNull();
  });

  it('activate=true sets the new path as activeFilePath', () => {
    const existing = '/tmp/existing.md';
    const newPath = '/tmp/new.md';
    const prevData = new Map([[existing, makeTab(existing, { isLoading: false })]]);
    const result = applyPendingTabState(prevData, [existing], existing, newPath, true);

    expect(result.activeFilePath).toBe(newPath);
    expect(result.tabOrder).toEqual([existing, newPath]);
  });

  it('activate=false preserves previous activeFilePath', () => {
    const existing = '/tmp/existing.md';
    const newPath = '/tmp/bg.md';
    const prevData = new Map([[existing, makeTab(existing, { isLoading: false })]]);
    const result = applyPendingTabState(prevData, [existing], existing, newPath, false);

    expect(result.activeFilePath).toBe(existing);
    expect(result.tabOrder).toEqual([existing, newPath]);
  });

  it('appends to the end of tabOrder', () => {
    const a = '/tmp/a.md';
    const b = '/tmp/b.md';
    const c = '/tmp/c.md';

    let state = applyPendingTabState(new Map(), [], null, a, true);
    state = applyPendingTabState(state.tabData, state.tabOrder, state.activeFilePath, b, false);
    state = applyPendingTabState(state.tabData, state.tabOrder, state.activeFilePath, c, false);

    expect(state.tabOrder).toEqual([a, b, c]);
  });
});

describe('applyLoadedTabState — extended', () => {
  it('same-path load updates content in place without modifying order', () => {
    const path = '/tmp/file.md';
    const prevData = new Map([[path, makeTab(path)]]);
    const result = applyLoadedTabState(
      prevData,
      [path],
      path,
      path,
      path,
      '# Content\n',
      new Date(),
    );

    expect(result.tabOrder).toEqual([path]);
    expect(result.activeFilePath).toBe(path);
    expect(result.tabData.get(path)).toMatchObject({
      rawMarkdown: '# Content\n',
      isLoading: false,
    });
  });

  it('preserves position in order when re-keying a tab', () => {
    const a = '/tmp/a.md';
    const link = '/tmp/link.md';
    const real = '/tmp/real.md';
    const c = '/tmp/c.md';

    const prevData = new Map<string, TabState>([
      [a, makeTab(a, { isLoading: false })],
      [link, makeTab(link)],
      [c, makeTab(c, { isLoading: false })],
    ]);

    const result = applyLoadedTabState(
      prevData,
      [a, link, c],
      link,
      link,
      real,
      '# Real\n',
      new Date(),
    );

    // 'real' should replace 'link' in position index 1
    expect(result.tabOrder).toEqual([a, real, c]);
    expect(result.tabData.has(link)).toBe(false);
    expect(result.tabData.get(real)?.rawMarkdown).toBe('# Real\n');
  });

  it('does not change activeFilePath when a non-active tab is re-keyed', () => {
    const active = '/tmp/active.md';
    const link = '/tmp/link.md';
    const real = '/tmp/real.md';

    const prevData = new Map<string, TabState>([
      [active, makeTab(active, { isLoading: false })],
      [link, makeTab(link)],
    ]);

    const result = applyLoadedTabState(
      prevData,
      [active, link],
      active,
      link,
      real,
      '# Content\n',
      new Date(),
    );

    // activeFilePath should remain 'active', not switch to 'real'
    expect(result.activeFilePath).toBe(active);
  });

  it('updates activeFilePath when the active tab is re-keyed', () => {
    const link = '/tmp/link.md';
    const real = '/tmp/real.md';
    const other = '/tmp/other.md';

    const prevData = new Map<string, TabState>([
      [link, makeTab(link)],
      [other, makeTab(other, { isLoading: false })],
    ]);

    const result = applyLoadedTabState(
      prevData,
      [link, other],
      link,
      link,
      real,
      '# Content\n',
      new Date(),
    );

    expect(result.activeFilePath).toBe(real);
  });

  it('sets lastSaved on loaded tab', () => {
    const path = '/tmp/file.md';
    const savedAt = new Date('2026-01-15T12:00:00.000Z');
    const prevData = new Map([[path, makeTab(path)]]);
    const result = applyLoadedTabState(prevData, [path], path, path, path, '# Content\n', savedAt);

    expect(result.tabData.get(path)?.lastSaved).toEqual(savedAt);
  });
});

describe('TabState dirty flag', () => {
  it('defaults to undefined (not dirty) on new tabs', () => {
    const path = '/tmp/test.md';
    const result = applyPendingTabState(new Map(), [], null, path, true);
    expect(result.tabData.get(path)?.dirty).toBeUndefined();
  });

  it('is preserved through applyLoadedTabState', () => {
    const path = '/tmp/test.md';
    const prevData = new Map([[path, makeTab(path, { dirty: true })]]);
    const result = applyLoadedTabState(prevData, [path], path, path, path, '# content', new Date());
    // applyLoadedTabState creates a new TabState without dirty, so it should be undefined
    expect(result.tabData.get(path)?.dirty).toBeUndefined();
  });

  it('can be cleared by spreading dirty:false over a dirty tab', () => {
    // This pattern is used by onExternalChange: external SSE content should
    // NOT mark the tab dirty since the content already matches disk.
    const path = '/tmp/test.md';
    const tab = makeTab(path, { dirty: true, rawMarkdown: '# old' });
    const updated = { ...tab, rawMarkdown: '# new', dirty: false };
    expect(updated.dirty).toBe(false);
    expect(updated.rawMarkdown).toBe('# new');
  });
});

describe('saveStateOf', () => {
  it('is saving while a write for the file is queued or in flight', () => {
    expect(saveStateOf(makeTab('/a.md', { dirty: true }), 1)).toBe('saving');
  });

  it('is failed when the last write errored and the edit never reached disk', () => {
    expect(saveStateOf(makeTab('/a.md', { dirty: true, error: 'conflict' }), 0)).toBe('failed');
  });

  it('is saved once the write landed', () => {
    expect(saveStateOf(makeTab('/a.md', { dirty: false, isLoading: false }), 0)).toBe('saved');
  });

  // A load error leaves nothing unsaved: the content shown is what is on disk.
  it('does not treat a load error as a failed save', () => {
    expect(saveStateOf(makeTab('/a.md', { error: 'Access denied' }), 0)).toBe('saved');
  });

  it('is saved for a file that is not open', () => {
    expect(saveStateOf(undefined, 0)).toBe('saved');
  });
});

describe('TabState errorKind', () => {
  it('applyPendingTabState initializes errorKind to null', () => {
    const result = applyPendingTabState(new Map(), [], null, '/tmp/x.md', true);
    expect(result.tabData.get('/tmp/x.md')?.errorKind).toBeNull();
  });

  it('applyLoadedTabState clears errorKind on success', () => {
    const path = '/tmp/x.md';
    const prevData = new Map<string, TabState>([
      [path, makeTab(path, { error: 'Access denied', errorKind: 'access-denied' })],
    ]);
    const result = applyLoadedTabState(
      prevData,
      [path],
      path,
      path,
      path,
      '# Loaded\n',
      new Date(),
    );
    expect(result.tabData.get(path)?.error).toBeNull();
    expect(result.tabData.get(path)?.errorKind).toBeNull();
  });
});

describe('isAccessDeniedError', () => {
  it('returns true for an Error whose message starts with "Access denied"', () => {
    expect(isAccessDeniedError(new Error('Access denied: path outside allowed directories'))).toBe(
      true,
    );
  });

  it('returns false for an Error with an unrelated message', () => {
    expect(isAccessDeniedError(new Error('File not found or not readable'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isAccessDeniedError('Access denied: foo')).toBe(false);
    expect(isAccessDeniedError(undefined)).toBe(false);
    expect(isAccessDeniedError(null)).toBe(false);
    expect(isAccessDeniedError({ message: 'Access denied: foo' })).toBe(false);
  });
});

describe('findAccessDeniedTabs', () => {
  it('returns paths of tabs whose errorKind is access-denied', () => {
    const tabs = new Map<string, TabState>([
      ['/a.md', makeTab('/a.md', { error: 'Access denied', errorKind: 'access-denied' })],
      ['/b.md', makeTab('/b.md', { error: 'Not found', errorKind: 'generic' })],
      ['/c.md', makeTab('/c.md', { error: null, errorKind: null, isLoading: false })],
      ['/d.md', makeTab('/d.md', { error: 'Access denied', errorKind: 'access-denied' })],
    ]);
    expect(findAccessDeniedTabs(tabs)).toEqual(['/a.md', '/d.md']);
  });

  it('returns an empty array when no tabs are access-denied', () => {
    const tabs = new Map<string, TabState>([
      ['/a.md', makeTab('/a.md', { error: 'Not found', errorKind: 'generic' })],
    ]);
    expect(findAccessDeniedTabs(tabs)).toEqual([]);
  });

  it('returns an empty array for an empty map', () => {
    expect(findAccessDeniedTabs(new Map())).toEqual([]);
  });
});

describe('useTabs: external content hooks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(responses: Array<{ path?: string; content: string; mtime?: number }>) {
    const queue = [...responses];
    const fetchMock = vi.fn(async (url: string) => {
      const next = queue.shift() ?? responses[responses.length - 1];
      const path = next.path ?? decodeURIComponent(String(url).split('path=')[1] ?? '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ path, content: next.content, mtime: next.mtime ?? 1 }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('routes reloaded content through onExternalContent before storing it', async () => {
    // Reload is the third way external content reaches a tab, and the one that
    // catches up on a reply both watchers missed. Skipping the hook here is
    // how the unread mark for that reply gets lost.
    stubFetch([{ content: '# before\n' }, { content: '# after\n' }]);
    const onExternalContent = vi.fn(() => '# after, stamped\n');
    const { result } = renderHook(() => useTabs({ onExternalContent }));

    await act(async () => {
      await result.current.openTab('/notes.md');
    });
    await act(async () => {
      await result.current.reloadFile();
    });

    expect(onExternalContent).toHaveBeenCalledWith('/notes.md', '# before\n', '# after\n', 1);
    await waitFor(() => expect(result.current.rawMarkdown).toBe('# after, stamped\n'));
  });

  it('reports a server-resolved path so path-keyed state can move with the tab', async () => {
    stubFetch([{ path: '/private/tmp/notes.md', content: '# loaded\n' }]);
    const onPathResolved = vi.fn();
    const { result } = renderHook(() => useTabs({ onPathResolved }));

    await act(async () => {
      await result.current.openTab('/tmp/notes.md');
    });

    expect(onPathResolved).toHaveBeenCalledWith('/tmp/notes.md', '/private/tmp/notes.md');
  });

  it('stays quiet when the path came back unchanged', async () => {
    stubFetch([{ content: '# loaded\n' }]);
    const onPathResolved = vi.fn();
    const { result } = renderHook(() => useTabs({ onPathResolved }));

    await act(async () => {
      await result.current.openTab('/notes.md');
    });

    expect(onPathResolved).not.toHaveBeenCalled();
  });
});

describe('useTabs save state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Two writes queued for one file: the first lands, the second fails. The
  // first must not mark the file clean while the second is still out, or the
  // failure reads as saved and a handoff goes out without the edit on disk.
  it('reports a failed save when the newest of two queued writes fails', async () => {
    const path = '/tmp/doc.md';
    const puts: Array<(res: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Promise<Response>((resolve) => puts.push(resolve));
        }
        return Promise.resolve(jsonResponse(200, { path, content: '# Doc\n', mtime: 1 }));
      }),
    );
    const { result } = renderHook(() => useTabs());
    await act(() => result.current.openTab(path));

    act(() => {
      result.current.setRawMarkdown('first');
      result.current.saveFile('first');
      result.current.setRawMarkdown('second');
      result.current.saveFile('second');
    });
    expect(result.current.getSaveState(path)).toBe('saving');

    await waitFor(() => expect(puts).toHaveLength(1));
    await act(async () => {
      puts[0](jsonResponse(200, { success: true, path, mtime: 2 }));
    });
    await waitFor(() => expect(puts).toHaveLength(2));
    await act(async () => {
      puts[1](jsonResponse(500, { error: 'disk full' }));
      await result.current.whenSaved();
    });

    expect(result.current.getSaveState(path)).toBe('failed');
  });
});

describe('useTabs: reopen closed tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Every GET answers with the path asked for, except the paths in `missing`,
  // which answer 404 the way the server does for a file deleted since.
  function stubFiles(missing = new Set<string>()) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
      if (missing.has(path)) {
        return new Response(JSON.stringify({ error: `File not found: ${path}` }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ path, content: `# ${path}\n`, mtime: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function openAll(paths: string[]) {
    const hook = renderHook(() => useTabs());
    for (const path of paths) {
      await act(() => hook.result.current.openTab(path));
    }
    return hook;
  }

  const order = (r: { current: ReturnType<typeof useTabs> }) =>
    r.current.tabs.map((t) => t.filePath);

  async function reopen(r: { current: ReturnType<typeof useTabs> }) {
    let reopened = false;
    await act(async () => {
      reopened = r.current.reopenClosedTab();
    });
    await waitFor(() => expect(r.current.tabs.every((t) => !t.isLoading)).toBe(true));
    return reopened;
  }

  it('has nothing to reopen before any tab closes', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md']);
    expect(result.current.canReopenClosedTab).toBe(false);
    let reopened = true;
    act(() => {
      reopened = result.current.reopenClosedTab();
    });
    expect(reopened).toBe(false);
    expect(order(result)).toEqual(['/a.md']);
  });

  it('reopens a single closed tab at its old index and activates it', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md']);
    act(() => result.current.closeTab('/b.md'));
    expect(order(result)).toEqual(['/a.md', '/c.md']);
    expect(result.current.canReopenClosedTab).toBe(true);

    expect(await reopen(result)).toBe(true);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md']);
    expect(result.current.activeFilePath).toBe('/b.md');
    expect(result.current.rawMarkdown).toBe('# /b.md\n');
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('reopens single closes newest first', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md', '/d.md']);
    act(() => result.current.closeTab('/c.md'));
    act(() => result.current.closeTab('/a.md'));
    expect(order(result)).toEqual(['/b.md', '/d.md']);

    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/d.md']);
    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
  });

  it('clamps the index when the strip has fewer tabs than before', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md']);
    act(() => result.current.closeTab('/c.md'));
    act(() => result.current.closeTab('/a.md'));
    act(() => result.current.closeTab('/b.md'));
    // Reopen b (index 1) into an empty strip: it lands at 0.
    await reopen(result);
    expect(order(result)).toEqual(['/b.md']);
  });

  it('restores Close Others one tab at a time, back in place', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md', '/d.md']);
    act(() => result.current.closeOtherTabs('/b.md'));
    expect(order(result)).toEqual(['/b.md']);

    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md']);
    expect(result.current.activeFilePath).toBe('/a.md');
    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md']);
    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('restores Close All one tab at a time, back in place', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md']);
    act(() => result.current.closeAllTabs());
    expect(order(result)).toEqual([]);

    await reopen(result);
    expect(order(result)).toEqual(['/a.md']);
    await reopen(result);
    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md']);
    expect(result.current.activeFilePath).toBe('/c.md');
  });

  it('restores Close Tabs to the Right one tab at a time, back in place', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md', '/d.md']);
    act(() => result.current.closeTabsToRight('/b.md'));
    expect(order(result)).toEqual(['/a.md', '/b.md']);

    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md']);
    await reopen(result);
    expect(order(result)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
  });

  it('records nothing when Close Tabs to the Right has nothing to close', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md']);
    act(() => result.current.closeTabsToRight('/b.md'));
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('forgets a closed tab once it is opened again some other way', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md', '/c.md']);
    act(() => result.current.closeTab('/b.md'));
    act(() => result.current.closeTab('/a.md'));
    await act(() => result.current.openTab('/a.md'));
    expect(order(result)).toEqual(['/c.md', '/a.md']);

    // The next reopen skips a.md, which is open, and brings back b.md.
    expect(await reopen(result)).toBe(true);
    expect(order(result)).toEqual(['/c.md', '/b.md', '/a.md']);
    expect(result.current.activeFilePath).toBe('/b.md');
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('forgets a closed tab opened again in the background', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md']);
    act(() => result.current.closeTab('/a.md'));
    await act(() => result.current.openTabInBackground('/a.md'));
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('switches to a closed path that is open again under another spelling', async () => {
    // /link.md resolves to /real.md. Opening /link.md again only learns it is
    // /real.md once the load answers, so the closed entry for /real.md goes
    // then, and a reopen has nothing left to do.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const asked = decodeURIComponent(String(url).split('path=')[1] ?? '');
        const path = asked === '/link.md' ? '/real.md' : asked;
        return new Response(JSON.stringify({ path, content: `# ${path}\n`, mtime: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { result } = await openAll(['/a.md', '/link.md']);
    expect(order(result)).toEqual(['/a.md', '/real.md']);
    act(() => result.current.closeTab('/real.md'));
    expect(result.current.canReopenClosedTab).toBe(true);
    await act(() => result.current.openTab('/link.md'));
    expect(order(result)).toEqual(['/a.md', '/real.md']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('keeps one entry per path, the newest', async () => {
    stubFiles();
    const { result } = await openAll(['/a.md', '/b.md']);
    act(() => result.current.closeTab('/a.md'));
    await act(() => result.current.openTab('/a.md'));
    act(() => result.current.closeTab('/a.md'));

    await reopen(result);
    expect(order(result)).toEqual(['/b.md', '/a.md']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('keeps only the 20 most recent closes', async () => {
    stubFiles();
    const paths = Array.from({ length: 25 }, (_, i) => `/f${i}.md`);
    const { result } = await openAll(paths);
    for (const path of paths) {
      act(() => result.current.closeTab(path));
    }

    const reopened: string[] = [];
    while (result.current.canReopenClosedTab) {
      await reopen(result);
      reopened.push(result.current.activeFilePath!);
    }
    expect(reopened).toEqual(paths.slice(5).reverse());
  });

  it('puts a file deleted since it closed in the missing-file error state', async () => {
    const missing = new Set<string>();
    stubFiles(missing);
    const { result } = await openAll(['/a.md', '/gone.md']);
    expect(result.current.tabs[1].error).toBeNull();
    act(() => result.current.closeTab('/gone.md'));
    missing.add('/gone.md');

    expect(await reopen(result)).toBe(true);
    expect(order(result)).toEqual(['/a.md', '/gone.md']);
    expect(result.current.activeFilePath).toBe('/gone.md');
    expect(result.current.error).toMatch(/File not found/);
    expect(result.current.errorKind).toBe('generic');
  });
});
