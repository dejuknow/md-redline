// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComments, type UseCommentsParams } from './useComments';

// ---------------------------------------------------------------------------
// Helpers: build raw markdown strings with embedded comment markers
// ---------------------------------------------------------------------------

function makeComment(overrides: Record<string, unknown> = {}): string {
  const data = {
    id: 'c1',
    anchor: 'hello',
    text: 'note',
    author: 'User',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
  return `<!-- @comment${JSON.stringify(data)} -->`;
}

function rawWithComments(
  ...comments: { before?: string; marker: string; after?: string }[]
): string {
  return comments.map((c) => `${c.before ?? ''}${c.marker}${c.after ?? ''}`).join('');
}

// ---------------------------------------------------------------------------
// Default params factory
// ---------------------------------------------------------------------------

function defaultParams(overrides: Partial<UseCommentsParams> = {}): UseCommentsParams {
  return {
    rawMarkdown: '',
    rawMarkdownRef: { current: '' },
    setRawMarkdown: vi.fn(),
    saveFile: vi.fn(),
    author: 'Tester',
    enableResolve: false,
    tabs: [],
    activeFilePath: null,
    viewerRef: {
      current: { scrollToComment: vi.fn() },
    } as unknown as UseCommentsParams['viewerRef'],
    rawViewRef: {
      current: { scrollToComment: vi.fn() },
    } as unknown as UseCommentsParams['rawViewRef'],
    showToast: vi.fn(),
    clearSelection: vi.fn(),
    setAutoExpandForm: vi.fn(),
    requestCommentFocus: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useComments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Stub crypto.randomUUID for deterministic IDs
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      randomUUID: vi.fn(() => 'new-uuid-1'),
    });
  });

  // -----------------------------------------------------------------------
  // 1. Comment parsing
  // -----------------------------------------------------------------------
  describe('comment parsing', () => {
    it('populates comments array from raw markdown with comment markers', () => {
      const raw = `Some text ${makeComment({ id: 'c1', anchor: 'hello', text: 'note one' })}hello world`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.comments).toHaveLength(1);
      expect(result.current.comments[0].id).toBe('c1');
      expect(result.current.comments[0].anchor).toBe('hello');
      expect(result.current.comments[0].text).toBe('note one');
    });

    it('strips comment markers from cleanMarkdown', () => {
      const raw = `Some text ${makeComment({ id: 'c1', anchor: 'hello' })}hello world`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.cleanMarkdown).toBe('Some text hello world');
      expect(result.current.cleanMarkdown).not.toContain('@comment');
    });

    it('renders html from clean markdown', () => {
      const raw = `# Title\n\n${makeComment({ id: 'c1', anchor: 'Title' })}`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.html).toContain('<h1');
      expect(result.current.html).toContain('Title');
    });

    it('handles undefined rawMarkdown', () => {
      const params = defaultParams({ rawMarkdown: undefined });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.comments).toEqual([]);
      expect(result.current.cleanMarkdown).toBe('');
      expect(result.current.html).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Comment counts per tab
  // -----------------------------------------------------------------------
  describe('commentCounts', () => {
    it('counts open comments for the active tab', () => {
      const raw = rawWithComments(
        { before: 'Text ', marker: makeComment({ id: 'c1', anchor: 'one' }), after: 'one ' },
        { marker: makeComment({ id: 'c2', anchor: 'two' }), after: 'two' },
      );
      const params = defaultParams({
        rawMarkdown: raw,
        tabs: [{ filePath: 'file.md', rawMarkdown: raw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCounts.get('file.md')).toBe(2);
    });

    it('counts comments for non-active tabs by parsing their rawMarkdown', () => {
      const activeRaw = `Active ${makeComment({ id: 'a1', anchor: 'Active' })}`;
      const otherRaw = rawWithComments(
        { before: 'X ', marker: makeComment({ id: 'o1', anchor: 'X' }), after: '' },
        { before: ' Y ', marker: makeComment({ id: 'o2', anchor: 'Y' }), after: '' },
        { before: ' Z ', marker: makeComment({ id: 'o3', anchor: 'Z' }), after: '' },
      );
      const params = defaultParams({
        rawMarkdown: activeRaw,
        tabs: [
          { filePath: 'active.md', rawMarkdown: activeRaw },
          { filePath: 'other.md', rawMarkdown: otherRaw },
        ],
        activeFilePath: 'active.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCounts.get('active.md')).toBe(1);
      expect(result.current.commentCounts.get('other.md')).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Resolved counts with enableResolve
  // -----------------------------------------------------------------------
  describe('resolvedCommentCounts', () => {
    it('counts resolved comments when enableResolve is true', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
          after: '',
        },
        {
          before: ' C ',
          marker: makeComment({ id: 'c3', anchor: 'C', status: 'open' }),
          after: '',
        },
      );
      const params = defaultParams({
        rawMarkdown: raw,
        enableResolve: true,
        tabs: [{ filePath: 'file.md', rawMarkdown: raw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      // 2 open, 1 resolved
      expect(result.current.commentCounts.get('file.md')).toBe(2);
      expect(result.current.resolvedCommentCounts.get('file.md')).toBe(1);
    });

    it('does not populate resolvedCommentCounts when enableResolve is false', () => {
      const raw = `Text ${makeComment({ id: 'c1', anchor: 'Text', status: 'resolved' })}`;
      const params = defaultParams({
        rawMarkdown: raw,
        enableResolve: false,
        tabs: [{ filePath: 'file.md', rawMarkdown: raw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.resolvedCommentCounts.has('file.md')).toBe(false);
      // All comments counted (resolved ones included)
      expect(result.current.commentCounts.get('file.md')).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 4. commentCount
  // -----------------------------------------------------------------------
  describe('commentCount', () => {
    it('returns total open comments when enableResolve is true', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
          after: '',
        },
        {
          before: ' C ',
          marker: makeComment({ id: 'c3', anchor: 'C', status: 'open' }),
          after: '',
        },
      );
      const params = defaultParams({ rawMarkdown: raw, enableResolve: true });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCount).toBe(2);
    });

    it('returns total comments when enableResolve is false', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
          after: '',
        },
      );
      const params = defaultParams({ rawMarkdown: raw, enableResolve: false });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 5. handleJumpToNext — wraps from last to first
  // -----------------------------------------------------------------------
  describe('handleJumpToNext', () => {
    it('wraps from last comment back to first', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A' }), after: '' },
        { before: ' B ', marker: makeComment({ id: 'c2', anchor: 'B' }), after: '' },
        { before: ' C ', marker: makeComment({ id: 'c3', anchor: 'C' }), after: '' },
      );
      const viewerRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['viewerRef'];
      const rawViewRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['rawViewRef'];
      const params = defaultParams({ rawMarkdown: raw, viewerRef, rawViewRef });
      const { result } = renderHook(() => useComments(params));

      // Navigate to c1 (first)
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c1');

      // Navigate to c2
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c2');

      // Navigate to c3
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c3');

      // Wrap to c1
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c1');

      expect(viewerRef.current!.scrollToComment).toHaveBeenCalledWith('c1');
      expect(rawViewRef.current!.scrollToComment).toHaveBeenCalledWith('c1');
    });
  });

  // -----------------------------------------------------------------------
  // 6. handleJumpToPrev — wraps from first to last
  // -----------------------------------------------------------------------
  describe('handleJumpToPrev', () => {
    it('wraps from first comment back to last', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A' }), after: '' },
        { before: ' B ', marker: makeComment({ id: 'c2', anchor: 'B' }), after: '' },
        { before: ' C ', marker: makeComment({ id: 'c3', anchor: 'C' }), after: '' },
      );
      const viewerRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['viewerRef'];
      const rawViewRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['rawViewRef'];
      const params = defaultParams({ rawMarkdown: raw, viewerRef, rawViewRef });
      const { result } = renderHook(() => useComments(params));

      // No active comment — jumping prev should go to last
      act(() => result.current.handleJumpToPrev());
      expect(result.current.activeCommentId).toBe('c3');

      // Prev from c3 → c2
      act(() => result.current.handleJumpToPrev());
      expect(result.current.activeCommentId).toBe('c2');

      // Prev from c2 → c1
      act(() => result.current.handleJumpToPrev());
      expect(result.current.activeCommentId).toBe('c1');

      // Wrap from c1 → c3
      act(() => result.current.handleJumpToPrev());
      expect(result.current.activeCommentId).toBe('c3');
    });
  });

  // -----------------------------------------------------------------------
  // 7. handleJumpToNext with resolve mode — skips resolved comments
  // -----------------------------------------------------------------------
  describe('handleJumpToNext with enableResolve', () => {
    it('skips resolved comments', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
          after: '',
        },
        {
          before: ' C ',
          marker: makeComment({ id: 'c3', anchor: 'C', status: 'open' }),
          after: '',
        },
      );
      const params = defaultParams({ rawMarkdown: raw, enableResolve: true });
      const { result } = renderHook(() => useComments(params));

      // First jump → c1 (first open)
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c1');

      // Next → c3 (skip c2 which is resolved)
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c3');

      // Wrap back to c1
      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBe('c1');
    });
  });

  // -----------------------------------------------------------------------
  // 8. handleAddComment — calls insertComment and updateAndSave
  // -----------------------------------------------------------------------
  describe('handleAddComment', () => {
    it('calls setRawMarkdown, saveFile, and sets activeCommentId', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const clearSelection = vi.fn();
      const requestCommentFocus = vi.fn();
      const setAutoExpandForm = vi.fn();
      const raw = 'Hello world';
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        author: 'Tester',
        clearSelection,
        requestCommentFocus,
        setAutoExpandForm,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => {
        result.current.handleAddComment('Hello', 'Nice greeting');
      });

      // Should have called setRawMarkdown and saveFile with new content containing comment marker
      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      expect(saveFile).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('@comment');
      expect(savedContent).toContain('Nice greeting');
      expect(savedContent).toContain('new-uuid-1');

      // Should set active comment id to the new UUID
      expect(result.current.activeCommentId).toBe('new-uuid-1');

      // Should call requestCommentFocus with the new id
      expect(requestCommentFocus).toHaveBeenCalledWith('new-uuid-1');

      // Should clear selection
      expect(clearSelection).toHaveBeenCalledTimes(1);

      // Should collapse form
      expect(setAutoExpandForm).toHaveBeenCalledWith(false);
    });
  });

  // -----------------------------------------------------------------------
  // 9. handleDelete — removes comment and clears activeCommentId if deleted
  // -----------------------------------------------------------------------
  describe('handleDelete', () => {
    it('calls setRawMarkdown and saveFile to remove the comment', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      // First set active comment to c1
      act(() => result.current.setActiveCommentId('c1'));
      expect(result.current.activeCommentId).toBe('c1');

      // Delete c1
      act(() => result.current.handleDelete('c1'));

      expect(setRawMarkdown).toHaveBeenCalled();
      expect(saveFile).toHaveBeenCalled();
      // Active comment should be cleared because it was the deleted one
      expect(result.current.activeCommentId).toBeNull();
    });

    it('does not clear activeCommentId if a different comment was deleted', () => {
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A' }), after: '' },
        { before: ' B ', marker: makeComment({ id: 'c2', anchor: 'B' }), after: '' },
      );
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
      });
      const { result } = renderHook(() => useComments(params));

      // Set active to c1
      act(() => result.current.setActiveCommentId('c1'));
      expect(result.current.activeCommentId).toBe('c1');

      // Delete c2 (different comment)
      act(() => result.current.handleDelete('c2'));

      // c1 should still be active
      expect(result.current.activeCommentId).toBe('c1');
    });
  });

  // -----------------------------------------------------------------------
  // 10. handleResolve / handleUnresolve
  // -----------------------------------------------------------------------
  describe('handleResolve and handleUnresolve', () => {
    it('handleResolve calls setRawMarkdown and saveFile with resolved content', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Text ${makeComment({ id: 'c1', anchor: 'Text', status: 'open' })}`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        enableResolve: true,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleResolve('c1'));

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      expect(saveFile).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('"status":"resolved"');
    });

    it('handleUnresolve calls setRawMarkdown and saveFile with unresolve content', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Text ${makeComment({ id: 'c1', anchor: 'Text', status: 'resolved' })}`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        enableResolve: true,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleUnresolve('c1'));

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      expect(saveFile).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('"status":"open"');
    });
  });

  // -----------------------------------------------------------------------
  // 11. handleBulkDelete — calls removeAllComments
  // -----------------------------------------------------------------------
  describe('handleBulkDelete', () => {
    it('removes all comments from the markdown', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A' }), after: '' },
        { before: ' B ', marker: makeComment({ id: 'c2', anchor: 'B' }), after: '' },
      );
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleBulkDelete());

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      expect(saveFile).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).not.toContain('@comment');
    });
  });

  // -----------------------------------------------------------------------
  // 12. missingAnchors — detects comments whose anchor is not in clean markdown
  // -----------------------------------------------------------------------
  describe('missingAnchors', () => {
    it('detects comments whose anchor text does not appear in clean markdown', () => {
      // Anchor is "missing text" but clean markdown won't contain it
      const raw = `Real content ${makeComment({ id: 'c1', anchor: 'missing text', status: 'open' })}here`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.missingAnchors.has('c1')).toBe(true);
    });

    it('does not flag comments whose anchor text is present', () => {
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.missingAnchors.has('c1')).toBe(false);
    });

    it('does not flag resolved comments as missing', () => {
      const raw = `Real content ${makeComment({ id: 'c1', anchor: 'missing text', status: 'resolved' })}here`;
      const params = defaultParams({ rawMarkdown: raw, enableResolve: true });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.missingAnchors.has('c1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 13. newOrphanIds — transition signal for ids that became orphaned
  // -----------------------------------------------------------------------
  describe('newOrphanIds', () => {
    it('is empty on first render', () => {
      const raw = `Real ${makeComment({ id: 'gone', anchor: 'absent', status: 'open' })}tail`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));
      expect(Array.from(result.current.newOrphanIds)).toEqual([]);
    });

    it('reflects the last missingAnchors transition and keeps identity stable across unchanged re-renders', () => {
      // Start: anchor present (no orphans).
      const rawOk = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      const params = defaultParams({ rawMarkdown: rawOk });
      const { result, rerender } = renderHook(
        (p: UseCommentsParams) => useComments(p),
        { initialProps: params },
      );
      expect(Array.from(result.current.newOrphanIds)).toEqual([]);
      const initialRef = result.current.newOrphanIds;

      // Rewrite removes the anchor — transition.
      const rawGone = `Greetings ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      rerender(defaultParams({ rawMarkdown: rawGone }));
      expect(Array.from(result.current.newOrphanIds)).toEqual(['c1']);
      const afterTransitionRef = result.current.newOrphanIds;
      expect(afterTransitionRef).not.toBe(initialRef);

      // Re-render with the same content — reference must be preserved so downstream
      // effects (e.g. a debounced toast) don't re-run and cancel their timers.
      rerender(defaultParams({ rawMarkdown: rawGone }));
      expect(result.current.newOrphanIds).toBe(afterTransitionRef);
    });
  });

  // -----------------------------------------------------------------------
  // Additional CRUD operations
  // -----------------------------------------------------------------------
  describe('handleEdit', () => {
    it('calls setRawMarkdown and saveFile with edited comment text', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello', text: 'old note' })}world`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleEdit('c1', 'new note'));

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('new note');
      expect(savedContent).not.toContain('old note');
    });
  });

  describe('handleReply', () => {
    it('calls setRawMarkdown and saveFile with reply added', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello', text: 'note' })}world`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        author: 'Replier',
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleReply('c1', 'reply text'));

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('reply text');
      expect(savedContent).toContain('Replier');
      expect(savedContent).toContain('"replies"');
    });
  });

  describe('handleBulkResolve', () => {
    it('resolves all comments', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'open' }),
          after: '',
        },
      );
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        enableResolve: true,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleBulkResolve());

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      expect(savedContent).toContain('"status":"resolved"');
      // Both should be resolved
      const matches = savedContent.match(/"status":"resolved"/g);
      expect(matches).toHaveLength(2);
    });
  });

  describe('handleBulkDeleteResolved', () => {
    it('removes only resolved comments', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = rawWithComments(
        { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
        {
          before: ' B ',
          marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
          after: '',
        },
      );
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        enableResolve: true,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleBulkDeleteResolved());

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      const savedContent = setRawMarkdown.mock.calls[0][0] as string;
      // c1 (open) should remain
      expect(savedContent).toContain('"id":"c1"');
      // c2 (resolved) should be removed
      expect(savedContent).not.toContain('"id":"c2"');
    });
  });

  describe('handleHighlightClick', () => {
    it('sets activeCommentId', () => {
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      const params = defaultParams({ rawMarkdown: raw });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleHighlightClick('c1'));
      expect(result.current.activeCommentId).toBe('c1');
    });
  });

  describe('handleSidebarActivate', () => {
    it('sets activeCommentId and scrolls both viewers', () => {
      const viewerRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['viewerRef'];
      const rawViewRef = {
        current: { scrollToComment: vi.fn() },
      } as unknown as UseCommentsParams['rawViewRef'];
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
      const params = defaultParams({ rawMarkdown: raw, viewerRef, rawViewRef });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleSidebarActivate('c1'));

      expect(result.current.activeCommentId).toBe('c1');
      expect(viewerRef.current!.scrollToComment).toHaveBeenCalledWith('c1');
      expect(rawViewRef.current!.scrollToComment).toHaveBeenCalledWith('c1');
    });
  });

  // -----------------------------------------------------------------------
  // updateAndSave — synchronous ref update for back-to-back mutations
  // -----------------------------------------------------------------------
  describe('back-to-back mutations', () => {
    it('second mutation sees the first mutation via rawMarkdownRef', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello', status: 'open' })}${makeComment({ id: 'c2', anchor: 'Hello', status: 'open' })}world`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        enableResolve: true,
      });
      const { result } = renderHook(() => useComments(params));

      // Resolve c1, then immediately delete c2 in the same synchronous block.
      // Without the ref fix, handleDelete would read the pre-resolve rawMarkdownRef
      // and the resolve would be lost.
      act(() => {
        result.current.handleResolve('c1');
        result.current.handleDelete('c2');
      });

      expect(setRawMarkdown).toHaveBeenCalledTimes(2);
      expect(saveFile).toHaveBeenCalledTimes(2);

      // The second call should contain the resolve from the first call
      const secondContent = setRawMarkdown.mock.calls[1][0] as string;
      // c1 should be resolved (still present with status resolved)
      expect(secondContent).toContain('"id":"c1"');
      expect(secondContent).toContain('"status":"resolved"');
      // c2 should be deleted
      expect(secondContent).not.toContain('"id":"c2"');

      // rawMarkdownRef should reflect the final state
      expect(rawMarkdownRef.current).toBe(secondContent);
    });
  });

  describe('navigation with no comments', () => {
    it('handleJumpToNext does nothing with no comments', () => {
      const params = defaultParams({ rawMarkdown: 'No comments here' });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleJumpToNext());
      expect(result.current.activeCommentId).toBeNull();
    });

    it('handleJumpToPrev does nothing with no comments', () => {
      const params = defaultParams({ rawMarkdown: 'No comments here' });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleJumpToPrev());
      expect(result.current.activeCommentId).toBeNull();
    });
  });

  describe('handleReanchorToSelection', () => {
    it('calls moveComment and writes the updated raw markdown', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw =
        `Hello ${makeComment({ id: 'c1', anchor: 'missing text', status: 'open' })}new anchor here`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      act(() =>
        result.current.handleReanchorToSelection('c1', 'new anchor', undefined),
      );

      expect(setRawMarkdown).toHaveBeenCalledTimes(1);
      const saved = setRawMarkdown.mock.calls[0][0] as string;
      expect(saved).toContain('"anchor":"new anchor"');
    });

    it('is a no-op when the new anchor is not present', () => {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'missing', status: 'open' })}world`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      act(() =>
        result.current.handleReanchorToSelection('c1', 'not in doc', undefined),
      );

      const saved = setRawMarkdown.mock.calls[0][0] as string;
      expect(saved).toContain('"anchor":"missing"');
    });
  });
});
