// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoSlot, type UndoEntry } from './useUndoSlot';

function entry(filePath: string | null, run = vi.fn()): UndoEntry {
  return { kind: 'comment-delete', what: 'delete', filePath, run };
}

describe('useUndoSlot', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useUndoSlot('a.md'));

    expect(result.current.available).toBeNull();
    expect(result.current.undoLast()).toBe(false);
  });

  it('offers the entry on its own file and runs it', () => {
    const { result } = renderHook(() => useUndoSlot('a.md'));
    const e = entry('a.md');

    act(() => result.current.offer(e));

    expect(result.current.available).toBe(e);
    let handled = false;
    act(() => {
      handled = result.current.undoLast();
    });
    expect(handled).toBe(true);
    expect(e.run).toHaveBeenCalledTimes(1);
  });

  it('holds one entry: a newer offer replaces the last', () => {
    const { result } = renderHook(() => useUndoSlot('a.md'));
    const first = entry('a.md');
    const second = entry('a.md');

    act(() => result.current.offer(first));
    act(() => result.current.offer(second));
    act(() => {
      result.current.undoLast();
    });

    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledTimes(1);
    expect(result.current.take(first)).toBe(false);
  });

  it('leaves the entry alone while another file is open', () => {
    const { result, rerender } = renderHook(({ path }) => useUndoSlot(path), {
      initialProps: { path: 'a.md' as string | null },
    });
    const e = entry('a.md');
    act(() => result.current.offer(e));

    rerender({ path: 'b.md' });

    expect(result.current.available).toBeNull();
    let handled = true;
    act(() => {
      handled = result.current.undoLast();
    });
    expect(handled).toBe(false);
    expect(e.run).not.toHaveBeenCalled();

    rerender({ path: 'a.md' });
    expect(result.current.available).toBe(e);
  });

  it('peek returns the entry on any file', () => {
    const { result, rerender } = renderHook(({ path }) => useUndoSlot(path), {
      initialProps: { path: 'a.md' as string | null },
    });
    const e = entry('a.md');
    act(() => result.current.offer(e));
    rerender({ path: 'b.md' });

    expect(result.current.peek()).toBe(e);
    expect(result.current.holds(e)).toBe(true);
  });

  it('take clears the slot once, and only for the entry it holds', () => {
    const { result } = renderHook(() => useUndoSlot('a.md'));
    const e = entry('a.md');
    act(() => result.current.offer(e));

    let first = false;
    let second = true;
    act(() => {
      first = result.current.take(e);
    });
    act(() => {
      second = result.current.take(e);
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(result.current.available).toBeNull();
    expect(result.current.undoLast()).toBe(false);
  });
});
