// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSearch } from './useSearch';

describe('useSearch', () => {
  it('handleSearchCount clamps activeSearchIndex when count decreases', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSearch(onClose));

    // Set count to 5, then navigate to index 4
    act(() => result.current.handleSearchCount(5));
    act(() => result.current.handleSearchNext()); // 1
    act(() => result.current.handleSearchNext()); // 2
    act(() => result.current.handleSearchNext()); // 3
    act(() => result.current.handleSearchNext()); // 4
    expect(result.current.activeSearchIndex).toBe(4);

    // Now reduce count to 3 — index should clamp to 2 (count - 1)
    act(() => result.current.handleSearchCount(3));
    expect(result.current.activeSearchIndex).toBe(2);
  });

  it('handleSearchCount resets index to 0 when count becomes 0', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSearch(onClose));

    act(() => result.current.handleSearchCount(5));
    act(() => result.current.handleSearchNext()); // 1
    expect(result.current.activeSearchIndex).toBe(1);

    act(() => result.current.handleSearchCount(0));
    expect(result.current.activeSearchIndex).toBe(0);
  });

  it('handleSearchNext wraps from last to first', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSearch(onClose));

    act(() => result.current.handleSearchCount(3));
    act(() => result.current.handleSearchNext()); // 1
    act(() => result.current.handleSearchNext()); // 2
    act(() => result.current.handleSearchNext()); // wraps to 0
    expect(result.current.activeSearchIndex).toBe(0);
  });

  it('handleSearchPrev wraps from first to last', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSearch(onClose));

    act(() => result.current.handleSearchCount(3));
    expect(result.current.activeSearchIndex).toBe(0);

    act(() => result.current.handleSearchPrev()); // wraps to 2
    expect(result.current.activeSearchIndex).toBe(2);
  });

  it('handleSearchQueryChange resets index to 0', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSearch(onClose));

    act(() => result.current.handleSearchCount(5));
    act(() => result.current.handleSearchNext()); // 1
    act(() => result.current.handleSearchNext()); // 2
    expect(result.current.activeSearchIndex).toBe(2);

    act(() => result.current.handleSearchQueryChange('new query'));
    expect(result.current.activeSearchIndex).toBe(0);
    expect(result.current.searchQuery).toBe('new query');
  });
});
