// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiffSnapshot } from './useDiffSnapshot';

const STORAGE_KEY = 'md-redline-snapshots';

function setup(activeFilePath: string | null = '/test.md', initialContent: string = 'hello world') {
  const rawMarkdownRef = { current: initialContent };
  const showToast = vi.fn();
  const setDiffEnabled = vi.fn();
  return {
    rawMarkdownRef,
    showToast,
    setDiffEnabled,
    hookArgs: [activeFilePath, rawMarkdownRef, showToast, setDiffEnabled] as const,
  };
}

describe('useDiffSnapshot', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('currentSnapshot is null when no snapshot exists for active file', () => {
    const { hookArgs } = setup();
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    expect(result.current.currentSnapshot).toBeNull();
  });

  it('handleSnapshot saves rawMarkdownRef.current to snapshots', () => {
    const { hookArgs, rawMarkdownRef } = setup('/test.md', 'file content');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.handleSnapshot());

    expect(result.current.currentSnapshot).toBe('file content');

    // Confirm it tracks the ref's value at call time
    rawMarkdownRef.current = 'changed';
    act(() => result.current.handleSnapshot());
    expect(result.current.currentSnapshot).toBe('changed');
  });

  it('after handleSnapshot, currentSnapshot returns the saved content', () => {
    const { hookArgs } = setup('/doc.md', 'saved text');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.handleSnapshot());
    expect(result.current.currentSnapshot).toBe('saved text');
  });

  it('handleSnapshot with extraEntries saves additional file snapshots', () => {
    const { hookArgs } = setup('/a.md', 'content a');
    const { result, rerender } = renderHook(({ args }) => useDiffSnapshot(...args), {
      initialProps: { args: hookArgs },
    });

    const extras = new Map([
      ['/b.md', 'content b'],
      ['/c.md', 'content c'],
    ]);
    act(() => result.current.handleSnapshot(extras));

    // Current file has its snapshot
    expect(result.current.currentSnapshot).toBe('content a');

    // Switch to /b.md to verify extra entry was saved
    const { hookArgs: bArgs } = setup('/b.md', '');
    rerender({ args: bArgs });
    expect(result.current.currentSnapshot).toBe('content b');
  });

  it('handleClearSnapshot removes the snapshot and calls setDiffEnabled(false)', () => {
    const { hookArgs, setDiffEnabled, showToast } = setup('/test.md', 'content');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.handleSnapshot());
    expect(result.current.currentSnapshot).toBe('content');

    act(() => result.current.handleClearSnapshot());
    expect(result.current.currentSnapshot).toBeNull();
    expect(setDiffEnabled).toHaveBeenCalledWith(false);
    expect(showToast).toHaveBeenCalledWith('Snapshot cleared');
  });

  it('first save shows "Snapshot saved", second shows "Snapshot updated"', () => {
    const rawMarkdownRef = { current: 'v1' };
    const showToast = vi.fn();
    const setDiffEnabled = vi.fn();

    const { result, rerender } = renderHook(
      ({ path }) => useDiffSnapshot(path, rawMarkdownRef, showToast, setDiffEnabled),
      { initialProps: { path: '/test.md' } },
    );

    // First snapshot
    act(() => result.current.handleSnapshot());
    expect(showToast).toHaveBeenLastCalledWith('Snapshot saved — diff view will show changes');

    // Force a re-render so the hook picks up committed state and recreates handleSnapshot
    rerender({ path: '/test.md' });

    // Second snapshot — should detect the existing entry
    act(() => result.current.handleSnapshot());
    expect(showToast).toHaveBeenLastCalledWith('Snapshot updated');
  });

  it('snapshots persist to localStorage', () => {
    const { hookArgs } = setup('/test.md', 'persisted');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.handleSnapshot());

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored['/test.md']).toBe('persisted');
  });

  it('initializes from localStorage on mount', () => {
    // Pre-populate localStorage
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ '/existing.md': 'pre-existing content' }));

    const { hookArgs } = setup('/existing.md', 'new content');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    // Should read the pre-existing snapshot, not null
    expect(result.current.currentSnapshot).toBe('pre-existing content');
  });
});
