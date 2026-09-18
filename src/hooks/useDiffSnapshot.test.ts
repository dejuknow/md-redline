// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiffSnapshot, type DiffReference } from './useDiffSnapshot';

const STORAGE_KEY = 'md-redline-snapshots';

function setup(activeFilePath: string | null = '/test.md', initialContent: string = 'hello world') {
  const rawMarkdownRef = { current: initialContent };
  return {
    rawMarkdownRef,
    hookArgs: [activeFilePath, rawMarkdownRef] as const,
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

  it('captureReference saves rawMarkdownRef.current to references', () => {
    const { hookArgs, rawMarkdownRef } = setup('/test.md', 'file content');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.captureReference('handoff'));

    expect(result.current.currentSnapshot).toBe('file content');

    // Confirm it tracks the ref's value at call time
    rawMarkdownRef.current = 'changed';
    act(() => result.current.captureReference('handoff'));
    expect(result.current.currentSnapshot).toBe('changed');
  });

  it('after captureReference, currentSnapshot returns the saved content', () => {
    const { hookArgs } = setup('/doc.md', 'saved text');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.captureReference('handoff'));
    expect(result.current.currentSnapshot).toBe('saved text');
  });

  it('captureReference with extraEntries saves additional file references', () => {
    const { hookArgs } = setup('/a.md', 'content a');
    const { result, rerender } = renderHook(({ args }) => useDiffSnapshot(...args), {
      initialProps: { args: hookArgs },
    });

    const extras = new Map([
      ['/b.md', 'content b'],
      ['/c.md', 'content c'],
    ]);
    act(() => result.current.captureReference('handoff', extras));

    // Current file has its reference
    expect(result.current.currentSnapshot).toBe('content a');

    // Switch to /b.md to verify extra entry was saved
    const { hookArgs: bArgs } = setup('/b.md', '');
    rerender({ args: bArgs });
    expect(result.current.currentSnapshot).toBe('content b');
  });

  it('references persist to localStorage', () => {
    const { hookArgs } = setup('/test.md', 'persisted');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    act(() => result.current.captureReference('handoff'));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored['/test.md']).toEqual(
      expect.objectContaining({ content: 'persisted', origin: 'handoff' }),
    );
  });

  it('initializes from localStorage on mount', () => {
    // Pre-populate localStorage
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ '/existing.md': 'pre-existing content' }));

    const { hookArgs } = setup('/existing.md', 'new content');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));

    // Should read the pre-existing snapshot, not null
    expect(result.current.currentSnapshot).toBe('pre-existing content');
  });

  it('migrates a legacy bare-string snapshot to a DiffReference', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ '/legacy.md': 'old content' }));
    const { hookArgs } = setup('/legacy.md', 'current');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    expect(result.current.currentSnapshot).toBe('old content');
    expect(result.current.currentReference).toEqual(
      expect.objectContaining({ content: 'old content', origin: 'handoff' }),
    );
    expect(typeof result.current.currentReference!.capturedAt).toBe('number');
  });

  it('preserves an already-valid stored DiffReference without re-stamping', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ '/rec.md': { content: 'x', capturedAt: 123456, origin: 'review' } }),
    );
    const { hookArgs } = setup('/rec.md', 'current');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    expect(result.current.currentReference).toEqual({
      content: 'x',
      capturedAt: 123456,
      origin: 'review',
    });
  });

  it('captureReference stores a record with the given origin and returns the previous reference', () => {
    const { hookArgs, rawMarkdownRef } = setup('/t.md', 'v1');
    const { result, rerender } = renderHook(({ args }) => useDiffSnapshot(...args), {
      initialProps: { args: hookArgs },
    });
    let prev: unknown;
    act(() => {
      prev = result.current.captureReference('handoff');
    });
    expect(prev).toBeNull();
    expect(result.current.currentReference).toEqual(
      expect.objectContaining({ content: 'v1', origin: 'handoff' }),
    );

    rerender({ args: hookArgs });
    rawMarkdownRef.current = 'v2';
    let prev2: unknown;
    act(() => {
      prev2 = result.current.captureReference('review');
    });
    expect(prev2).toEqual(expect.objectContaining({ content: 'v1', origin: 'handoff' }));
    expect(result.current.currentReference).toEqual(
      expect.objectContaining({ content: 'v2', origin: 'review' }),
    );
  });

  it('restoreReference puts a specific reference back (Undo)', () => {
    const { hookArgs, rawMarkdownRef } = setup('/t.md', 'v1');
    const { result, rerender } = renderHook(({ args }) => useDiffSnapshot(...args), {
      initialProps: { args: hookArgs },
    });
    // First capture establishes the v1 handoff reference.
    act(() => {
      result.current.captureReference('handoff');
    });
    rerender({ args: hookArgs });

    // Advancing to v2 returns the previous (v1) reference; that is what Undo restores.
    rawMarkdownRef.current = 'v2';
    let prev: DiffReference | null = null;
    act(() => {
      prev = result.current.captureReference('review') as DiffReference | null;
    });
    expect(prev).toEqual(expect.objectContaining({ content: 'v1', origin: 'handoff' }));
    expect(result.current.currentSnapshot).toBe('v2');

    rerender({ args: hookArgs });
    act(() => result.current.restoreReference(prev));
    expect(result.current.currentSnapshot).toBe('v1');
  });
});

describe('agent-captured references', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const agentRef = (capturedAt: number, content = 'agent copy'): DiffReference => ({
    content,
    capturedAt,
    origin: 'agent',
    agentName: 'Claude',
  });

  it('seedReference stores a reference for a path with none', () => {
    const { hookArgs } = setup('/a.md', 'now');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    let seeded = false;
    act(() => {
      seeded = result.current.seedReference('/a.md', agentRef(100));
    });
    expect(seeded).toBe(true);
    expect(result.current.currentReference).toEqual(agentRef(100));
  });

  it('seedReference replaces an older local reference', () => {
    const { hookArgs } = setup('/a.md', 'now');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    act(() => result.current.captureReference('handoff'));
    const older = result.current.currentReference!.capturedAt;
    let seeded = false;
    act(() => {
      seeded = result.current.seedReference('/a.md', agentRef(older + 1));
    });
    expect(seeded).toBe(true);
    expect(result.current.currentReference?.origin).toBe('agent');
  });

  it('seedReference keeps a newer local reference (newest wins)', () => {
    const { hookArgs } = setup('/a.md', 'now');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    act(() => result.current.captureReference('review'));
    const local = result.current.currentReference!.capturedAt;
    let seeded = true;
    act(() => {
      seeded = result.current.seedReference('/a.md', agentRef(local - 1));
    });
    expect(seeded).toBe(false);
    expect(result.current.currentReference?.origin).toBe('review');
  });

  it('seedReference works for a path that is not the active file', () => {
    const { hookArgs } = setup('/a.md', 'now');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    act(() => {
      result.current.seedReference('/b.md', agentRef(5, 'b before'));
    });
    expect(result.current.getReference('/b.md')).toEqual(agentRef(5, 'b before'));
    expect(result.current.currentReference).toBeNull();
  });

  it('persists and reloads the agent origin and name', () => {
    const { hookArgs } = setup('/a.md', 'now');
    const first = renderHook(() => useDiffSnapshot(...hookArgs));
    act(() => {
      first.result.current.seedReference('/a.md', agentRef(7));
    });
    first.unmount();
    const second = renderHook(() => useDiffSnapshot(...hookArgs));
    expect(second.result.current.currentReference).toEqual(agentRef(7));
  });

  it('migrates an unknown stored origin to handoff', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ '/a.md': { content: 'x', capturedAt: 1, origin: 'weird', agentName: 9 } }),
    );
    const { hookArgs } = setup('/a.md', 'now');
    const { result } = renderHook(() => useDiffSnapshot(...hookArgs));
    expect(result.current.currentReference).toEqual({
      content: 'x',
      capturedAt: 1,
      origin: 'handoff',
    });
  });
});
