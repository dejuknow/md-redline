// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUnreadReplies } from './useUnreadReplies';

describe('useUnreadReplies', () => {
  it('accumulates unread replies per file path', () => {
    const { result } = renderHook(() => useUnreadReplies());

    act(() => result.current.markRepliesUnread('/a.md', ['r1']));
    act(() => result.current.markRepliesUnread('/a.md', ['r2']));
    act(() => result.current.markRepliesUnread('/b.md', ['r3']));

    expect(result.current.unreadByPath['/a.md']).toEqual(['r1', 'r2']);
    expect(result.current.unreadByPath['/b.md']).toEqual(['r3']);
  });

  it('clears only the replies that were read, leaving the rest unread', () => {
    const { result } = renderHook(() => useUnreadReplies());

    act(() => result.current.markRepliesUnread('/a.md', ['r1', 'r2', 'r3']));
    act(() => result.current.markRepliesRead('/a.md', ['r2']));

    expect(result.current.unreadByPath['/a.md']).toEqual(['r1', 'r3']);
  });

  it('keeps the same state object when nothing actually changes', () => {
    // App re-runs markRepliesRead on every reparse of the active comment, so a
    // no-op has to be referentially stable or it re-renders the whole tree on
    // each keystroke an agent writes.
    const { result } = renderHook(() => useUnreadReplies());

    act(() => result.current.markRepliesUnread('/a.md', ['r1']));
    const afterMark = result.current.unreadByPath;

    act(() => result.current.markRepliesUnread('/a.md', ['r1']));
    act(() => result.current.markRepliesUnread('/a.md', []));
    act(() => result.current.markRepliesRead('/a.md', ['r-elsewhere']));
    act(() => result.current.markRepliesRead('/never-seen.md', ['r1']));

    expect(result.current.unreadByPath).toBe(afterMark);
  });

  it('deduplicates a reply seen twice, so a redelivered SSE event does not double it', () => {
    const { result } = renderHook(() => useUnreadReplies());

    act(() => result.current.markRepliesUnread('/a.md', ['r1', 'r1']));
    act(() => result.current.markRepliesUnread('/a.md', ['r1', 'r2']));

    expect(result.current.unreadByPath['/a.md']).toEqual(['r1', 'r2']);
  });
});
