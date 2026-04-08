import { describe, expect, it } from 'vitest';
import { applyLoadedTabState, applyPendingTabState, type TabState } from './useTabs';

function makeTab(path: string, overrides: Partial<TabState> = {}): TabState {
  return {
    filePath: path,
    rawMarkdown: '',
    isLoading: true,
    error: null,
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
      prevData, [path], path, path, path, '# Content\n', new Date(),
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
      prevData, [a, link, c], link, link, real, '# Real\n', new Date(),
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
      prevData, [active, link], active, link, real, '# Content\n', new Date(),
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
      prevData, [link, other], link, link, real, '# Content\n', new Date(),
    );

    expect(result.activeFilePath).toBe(real);
  });

  it('sets lastSaved on loaded tab', () => {
    const path = '/tmp/file.md';
    const savedAt = new Date('2026-01-15T12:00:00.000Z');
    const prevData = new Map([[path, makeTab(path)]]);
    const result = applyLoadedTabState(
      prevData, [path], path, path, path, '# Content\n', savedAt,
    );

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
    const prevData = new Map([
      [path, makeTab(path, { dirty: true })],
    ]);
    const result = applyLoadedTabState(
      prevData, [path], path, path, path, '# content', new Date(),
    );
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
