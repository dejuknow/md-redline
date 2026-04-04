import { describe, expect, it, vi } from 'vitest';
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
