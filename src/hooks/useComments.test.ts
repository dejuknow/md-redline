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
    keepLineBreaks: false,
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
  // 3. Resolved comments: counted or gone depending on the resolve workflow
  // -----------------------------------------------------------------------
  // With the resolve workflow on, a resolved comment counts as gone: it leaves
  // the tab badge and the Send set (commentIdsByFile). With it off, the
  // highlight, card and List view still show a resolved marker as open (with
  // Reply), so it stays counted and sendable. Excluding it would silently drop
  // a reply typed there. A resolved agent question is out of the agent count in
  // both modes, since "Awaiting your reply" only surfaces open ones.
  describe.each([
    {
      mode: 'on',
      enableResolve: true,
      badge: 2,
      ids: ['c1', 'c3'],
      otherIds: ['o1', 'o3'],
      agentBadge: 0,
    },
    {
      mode: 'off',
      enableResolve: false,
      badge: 3,
      ids: ['c1', 'c2', 'c3'],
      otherIds: ['o1', 'o2', 'o3'],
      agentBadge: 0,
    },
  ])(
    'resolved comments with enableResolve $mode',
    ({ enableResolve, badge, ids, otherIds, agentBadge }) => {
      // Two open and one resolved user comment: `${prefix}2` is the resolved one.
      const mixed = (prefix: string) =>
        rawWithComments(
          {
            before: 'A ',
            marker: makeComment({ id: `${prefix}1`, anchor: 'A', status: 'open' }),
            after: '',
          },
          {
            before: ' B ',
            marker: makeComment({ id: `${prefix}2`, anchor: 'B', status: 'resolved' }),
            after: '',
          },
          {
            before: ' C ',
            marker: makeComment({ id: `${prefix}3`, anchor: 'C', status: 'open' }),
            after: '',
          },
        );
      const mixedRaw = mixed('c');
      const otherMixedRaw = mixed('o');
      const activeRaw = `Active ${makeComment({ id: 'a1', anchor: 'Active', status: 'open' })}`;

      // App's tabCommentCounts adds agentCommentCounts to commentCounts, so the
      // badge a tab draws is the sum of the two maps.
      const resolvedAgentRaw = rawWithComments(
        {
          before: 'A ',
          marker: makeComment({ id: 'g1', anchor: 'A', status: 'resolved', agentInitiated: true }),
          after: '',
        },
        {
          before: ' B ',
          marker: makeComment({ id: 'g2', anchor: 'B', resolved: true, agentInitiated: true }),
          after: '',
        },
      );
      const tabBadge = (
        r: { commentCounts: Map<string, number>; agentCommentCounts: Map<string, number> },
        path: string,
      ) => (r.commentCounts.get(path) ?? 0) + (r.agentCommentCounts.get(path) ?? 0);

      it('sets the active-tab badge and Send set', () => {
        const params = defaultParams({
          rawMarkdown: mixedRaw,
          enableResolve,
          tabs: [{ filePath: 'file.md', rawMarkdown: mixedRaw }],
          activeFilePath: 'file.md',
        });
        const { result } = renderHook(() => useComments(params));

        expect(result.current.commentCounts.get('file.md')).toBe(badge);
        expect(result.current.commentIdsByFile.get('file.md')).toEqual(ids);
      });

      it('sets an inactive-tab badge and Send set', () => {
        const params = defaultParams({
          rawMarkdown: activeRaw,
          enableResolve,
          tabs: [
            { filePath: 'active.md', rawMarkdown: activeRaw },
            { filePath: 'other.md', rawMarkdown: otherMixedRaw },
          ],
          activeFilePath: 'active.md',
        });
        const { result } = renderHook(() => useComments(params));

        expect(result.current.commentCounts.get('other.md')).toBe(badge);
        expect(result.current.commentIdsByFile.get('other.md')).toEqual(otherIds);
      });

      it('sets the agent count for an active tab whose only comments are resolved agent comments', () => {
        const params = defaultParams({
          rawMarkdown: resolvedAgentRaw,
          enableResolve,
          tabs: [{ filePath: 'file.md', rawMarkdown: resolvedAgentRaw }],
          activeFilePath: 'file.md',
        });
        const { result } = renderHook(() => useComments(params));

        expect(result.current.agentCommentCounts.get('file.md')).toBe(agentBadge);
        expect(tabBadge(result.current, 'file.md')).toBe(agentBadge);
      });

      it('sets the agent count for an inactive tab whose only comments are resolved agent comments', () => {
        const params = defaultParams({
          rawMarkdown: activeRaw,
          enableResolve,
          tabs: [
            { filePath: 'active.md', rawMarkdown: activeRaw },
            { filePath: 'other.md', rawMarkdown: resolvedAgentRaw },
          ],
          activeFilePath: 'active.md',
        });
        const { result } = renderHook(() => useComments(params));

        expect(result.current.agentCommentCounts.get('other.md')).toBe(agentBadge);
        expect(tabBadge(result.current, 'other.md')).toBe(agentBadge);
      });
    },
  );

  describe('fully resolved file', () => {
    const resolvedRaw = rawWithComments(
      {
        before: 'A ',
        marker: makeComment({ id: 'c1', anchor: 'A', status: 'resolved' }),
        after: '',
      },
      {
        before: ' B ',
        marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
        after: '',
      },
    );

    it('reads 0 with enableResolve on, the same as a file with no comments', () => {
      const params = defaultParams({
        rawMarkdown: resolvedRaw,
        enableResolve: true,
        tabs: [{ filePath: 'file.md', rawMarkdown: resolvedRaw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCounts.get('file.md')).toBe(0);
      expect(result.current.commentIdsByFile.get('file.md')).toEqual([]);
    });

    it('keeps both comments counted and sendable with enableResolve off', () => {
      const params = defaultParams({
        rawMarkdown: resolvedRaw,
        enableResolve: false,
        tabs: [{ filePath: 'file.md', rawMarkdown: resolvedRaw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCounts.get('file.md')).toBe(2);
      expect(result.current.commentIdsByFile.get('file.md')).toEqual(['c1', 'c2']);
    });
  });

  // -----------------------------------------------------------------------
  // 3b. resolvedCommentCounts (the "N resolved" tab badge) needs resolve on
  // -----------------------------------------------------------------------
  describe('resolvedCommentCounts', () => {
    const resolvedRaw = rawWithComments(
      { before: 'A ', marker: makeComment({ id: 'c1', anchor: 'A', status: 'open' }), after: '' },
      {
        before: ' B ',
        marker: makeComment({ id: 'c2', anchor: 'B', status: 'resolved' }),
        after: '',
      },
      {
        before: ' C ',
        marker: makeComment({ id: 'c3', anchor: 'C', resolved: true }),
        after: '',
      },
      {
        before: ' D ',
        marker: makeComment({ id: 'g1', anchor: 'D', status: 'resolved', agentInitiated: true }),
        after: '',
      },
    );
    const activeRaw = `Active ${makeComment({ id: 'a1', anchor: 'Active', status: 'open' })}`;

    it('counts resolved user comments for the active tab when enableResolve is true', () => {
      const params = defaultParams({
        rawMarkdown: resolvedRaw,
        enableResolve: true,
        tabs: [{ filePath: 'file.md', rawMarkdown: resolvedRaw }],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      // c2 (status) and c3 (legacy flag) are resolved; the agent comment is not counted here.
      expect(result.current.resolvedCommentCounts.get('file.md')).toBe(2);
    });

    it('counts resolved user comments for an inactive tab when enableResolve is true', () => {
      const params = defaultParams({
        rawMarkdown: activeRaw,
        enableResolve: true,
        tabs: [
          { filePath: 'active.md', rawMarkdown: activeRaw },
          { filePath: 'other.md', rawMarkdown: resolvedRaw },
        ],
        activeFilePath: 'active.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.resolvedCommentCounts.get('active.md')).toBe(0);
      expect(result.current.resolvedCommentCounts.get('other.md')).toBe(2);
    });

    it('is empty when enableResolve is false', () => {
      const params = defaultParams({
        rawMarkdown: resolvedRaw,
        enableResolve: false,
        tabs: [
          { filePath: 'file.md', rawMarkdown: resolvedRaw },
          { filePath: 'other.md', rawMarkdown: resolvedRaw },
        ],
        activeFilePath: 'file.md',
      });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.resolvedCommentCounts.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. commentCount
  // -----------------------------------------------------------------------
  describe('commentCount', () => {
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

    it('returns total open comments when enableResolve is true', () => {
      const params = defaultParams({ rawMarkdown: raw, enableResolve: true });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCount).toBe(2);
    });

    it('returns total comments, resolved included, when enableResolve is false', () => {
      const params = defaultParams({ rawMarkdown: raw, enableResolve: false });
      const { result } = renderHook(() => useComments(params));

      expect(result.current.commentCount).toBe(3);
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
    it('reports a failure instead of saving a no-op when the anchor is not found', () => {
      // insertComment returns the document unchanged when it cannot place the
      // marker. Saving that as success loses the comment with no marker and no
      // error, and asks focus for an id that was never written.
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const showToast = vi.fn();
      const requestCommentFocus = vi.fn();
      const raw = 'Hello world';
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        showToast,
        requestCommentFocus,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => {
        result.current.handleAddComment('text that is not in the document', 'note');
      });

      expect(saveFile).not.toHaveBeenCalled();
      expect(setRawMarkdown).not.toHaveBeenCalled();
      expect(requestCommentFocus).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't anchor"), 'error');
    });

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

      // Should NOT activate the new comment: activating it would pin its
      // margin card and shove the anchored-rail cluster (crit round 2, item 04).
      expect(result.current.activeCommentId).toBeNull();

      // Creation requests focus with the 'creation' origin and does NOT
      // activate the comment: the anchored rail leaves the resting stack
      // anchor-aligned (crit round 2, item 04).
      expect(requestCommentFocus).toHaveBeenCalledWith('new-uuid-1', 'creation');

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
  // 9b. Undo for a deleted comment or reply
  // -----------------------------------------------------------------------
  describe('undo a delete', () => {
    const UNDO_ERROR = "Couldn't undo. The file changed after the delete.";
    const OTHER_FILE_ERROR = "Couldn't undo. The delete was in another file.";

    function setup(raw: string, overrides: Partial<UseCommentsParams> = {}) {
      const setRawMarkdown = vi.fn();
      const saveFile = vi.fn();
      const showToast = vi.fn();
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
        showToast,
        activeFilePath: 'a.md',
        ...overrides,
      });
      const hook = renderHook((p: UseCommentsParams) => useComments(p), { initialProps: params });
      return { ...hook, params, setRawMarkdown, saveFile, showToast, rawMarkdownRef };
    }

    /** The Undo action handed to the most recent toast. */
    function undoAction(showToast: ReturnType<typeof vi.fn>) {
      const call = showToast.mock.calls.at(-1) as unknown[] | undefined;
      const action = call?.[2] as { label: string; onClick: () => void } | undefined;
      if (!action) throw new Error('the last toast has no action');
      return action;
    }

    const commentRaw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world`;
    const replyRaw = `Hello ${makeComment({
      id: 'c1',
      anchor: 'Hello',
      replies: [
        { id: 'r1', text: 'first reply', author: 'Bot', timestamp: '2024-01-02T00:00:00.000Z' },
        { id: 'r2', text: 'second reply', author: 'User', timestamp: '2024-01-03T00:00:00.000Z' },
      ],
    })}world`;

    describe('comment', () => {
      it('shows a toast with an Undo action', () => {
        const { result, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));

        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast).toHaveBeenCalledWith('Comment deleted.', 'info', {
          label: 'Undo',
          onClick: expect.any(Function),
        });
      });

      it('Undo restores the exact pre-delete markdown and brings the comment back into view', () => {
        const { result, params, setRawMarkdown, saveFile, showToast, rawMarkdownRef } =
          setup(commentRaw);
        act(() => result.current.setActiveCommentId('c1'));

        act(() => result.current.handleDelete('c1'));
        expect(rawMarkdownRef.current).not.toContain('"id":"c1"');
        expect(result.current.activeCommentId).toBeNull();
        setRawMarkdown.mockClear();
        saveFile.mockClear();

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).toHaveBeenCalledTimes(1);
        expect(setRawMarkdown).toHaveBeenCalledWith(commentRaw);
        expect(saveFile).toHaveBeenCalledTimes(1);
        expect(saveFile).toHaveBeenCalledWith(commentRaw);
        expect(rawMarkdownRef.current).toBe(commentRaw);
        // The same request "Jump to agent question" makes: it scrolls to the
        // card, focuses it, and selects it in Anchored density. Setting the
        // active id directly would skip that, since the jump only selects a
        // card that isn't already active.
        expect(params.requestCommentFocus).toHaveBeenCalledWith('c1', 'jump');
        // No error toast: the delete toast, then the confirmation.
        expect(showToast).toHaveBeenCalledTimes(2);
        expect(showToast).toHaveBeenLastCalledWith('Comment restored.', 'info');
      });

      it('Undo does not write when the markdown changed after the delete', () => {
        const { result, setRawMarkdown, saveFile, showToast, rawMarkdownRef } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        const afterDelete = rawMarkdownRef.current as string;
        setRawMarkdown.mockClear();
        saveFile.mockClear();
        // An agent edit, or any other comment action, lands after the delete.
        rawMarkdownRef.current = `${afterDelete} edited elsewhere`;

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(rawMarkdownRef.current).toBe(`${afterDelete} edited elsewhere`);
        expect(result.current.activeCommentId).toBeNull();
        expect(showToast).toHaveBeenLastCalledWith(UNDO_ERROR, 'error');
      });

      it('Undo does not write when the active file changed after the delete', () => {
        const { result, rerender, params, setRawMarkdown, saveFile, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        setRawMarkdown.mockClear();
        saveFile.mockClear();
        // Switching tabs: Undo must read the path at click time, not the one
        // closed over when the delete ran. Same raw string, different file.
        rerender({ ...params, activeFilePath: 'b.md' });

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(result.current.activeCommentId).toBeNull();
        expect(params.requestCommentFocus).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenLastCalledWith(OTHER_FILE_ERROR, 'error');

        // The delete is still kept: back on its own file, Cmd+Z restores it.
        rerender({ ...params, activeFilePath: 'a.md' });
        act(() => {
          result.current.undoLastDelete();
        });
        expect(setRawMarkdown).toHaveBeenCalledWith(commentRaw);
      });

      it('Undo still works after a re-render that keeps the same file', () => {
        const { result, rerender, params, setRawMarkdown, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        setRawMarkdown.mockClear();
        rerender({ ...params });

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).toHaveBeenCalledWith(commentRaw);
      });

      it('does not offer Undo when the comment id matches nothing', () => {
        const { result, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('missing'));

        expect(showToast).not.toHaveBeenCalled();
      });
    });

    describe('reply', () => {
      it('shows a toast with an Undo action', () => {
        const { result, showToast } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));

        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast).toHaveBeenCalledWith('Reply deleted.', 'info', {
          label: 'Undo',
          onClick: expect.any(Function),
        });
      });

      it('Undo restores the exact pre-delete markdown', () => {
        const { result, setRawMarkdown, saveFile, showToast, rawMarkdownRef } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));
        expect(rawMarkdownRef.current).not.toContain('first reply');
        expect(rawMarkdownRef.current).toContain('second reply');
        setRawMarkdown.mockClear();
        saveFile.mockClear();

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).toHaveBeenCalledTimes(1);
        expect(setRawMarkdown).toHaveBeenCalledWith(replyRaw);
        expect(saveFile).toHaveBeenCalledWith(replyRaw);
        expect(rawMarkdownRef.current).toBe(replyRaw);
        expect(showToast).toHaveBeenCalledTimes(2);
        expect(showToast).toHaveBeenLastCalledWith('Reply restored.', 'info');
      });

      it('Undo does not touch the active comment', () => {
        const { result, showToast } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));
        act(() => undoAction(showToast).onClick());

        expect(result.current.activeCommentId).toBeNull();
      });

      it('Undo does not write when the markdown changed after the delete', () => {
        const { result, setRawMarkdown, saveFile, showToast, rawMarkdownRef } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));
        const afterDelete = rawMarkdownRef.current as string;
        setRawMarkdown.mockClear();
        saveFile.mockClear();
        rawMarkdownRef.current = `${afterDelete} edited elsewhere`;

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(rawMarkdownRef.current).toBe(`${afterDelete} edited elsewhere`);
        expect(showToast).toHaveBeenLastCalledWith(UNDO_ERROR, 'error');
      });

      it('Undo does not write when the active file changed after the delete', () => {
        const { result, rerender, params, setRawMarkdown, saveFile, showToast } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));
        setRawMarkdown.mockClear();
        saveFile.mockClear();
        rerender({ ...params, activeFilePath: 'b.md' });

        act(() => undoAction(showToast).onClick());

        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenLastCalledWith(OTHER_FILE_ERROR, 'error');
      });

      it('does not offer Undo when the reply id matches nothing', () => {
        const { result, showToast } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'missing'));

        expect(showToast).not.toHaveBeenCalled();
      });
    });

    // Cmd+Z and the palette's "Undo last delete": the same restore, without
    // the toast's 5 seconds.
    describe('undo the last delete after its toast', () => {
      const twoCommentRaw = `Hello ${makeComment({ id: 'c1', anchor: 'Hello' })}world ${makeComment(
        { id: 'c2', anchor: 'world' },
      )}`;

      it('does nothing when nothing was deleted', () => {
        const { result, setRawMarkdown, showToast } = setup(commentRaw);

        let handled = true;
        act(() => {
          handled = result.current.undoLastDelete();
        });

        expect(handled).toBe(false);
        expect(result.current.canUndoDelete).toBe(false);
        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
      });

      it('restores a deleted comment, brings it into view, and confirms', () => {
        const { result, rerender, params, setRawMarkdown, saveFile, showToast, rawMarkdownRef } =
          setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        rerender({ ...params, rawMarkdown: rawMarkdownRef.current });
        expect(result.current.canUndoDelete).toBe(true);
        setRawMarkdown.mockClear();
        saveFile.mockClear();

        let handled = false;
        act(() => {
          handled = result.current.undoLastDelete();
        });

        expect(handled).toBe(true);
        expect(setRawMarkdown).toHaveBeenCalledWith(commentRaw);
        expect(saveFile).toHaveBeenCalledWith(commentRaw);
        expect(params.requestCommentFocus).toHaveBeenCalledWith('c1', 'jump');
        expect(showToast).toHaveBeenLastCalledWith('Comment restored.', 'info');
        expect(result.current.canUndoDelete).toBe(false);
      });

      it('restores a deleted reply and confirms', () => {
        const { result, setRawMarkdown, showToast } = setup(replyRaw);

        act(() => result.current.handleDeleteReply('c1', 'r1'));
        act(() => {
          result.current.undoLastDelete();
        });

        expect(setRawMarkdown).toHaveBeenLastCalledWith(replyRaw);
        expect(showToast).toHaveBeenLastCalledWith('Reply restored.', 'info');
      });

      it('undoes only the most recent delete', () => {
        const { result, setRawMarkdown, rawMarkdownRef } = setup(twoCommentRaw);

        act(() => result.current.handleDelete('c1'));
        const afterFirst = rawMarkdownRef.current;
        act(() => result.current.handleDelete('c2'));
        setRawMarkdown.mockClear();

        let first = false;
        let second = true;
        act(() => {
          first = result.current.undoLastDelete();
        });
        act(() => {
          second = result.current.undoLastDelete();
        });

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(setRawMarkdown).toHaveBeenCalledTimes(1);
        expect(setRawMarkdown).toHaveBeenCalledWith(afterFirst);
      });

      it('refuses and forgets the delete when the markdown changed after it', () => {
        const { result, rerender, params, setRawMarkdown, saveFile, showToast, rawMarkdownRef } =
          setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        const edited = `${rawMarkdownRef.current} edited elsewhere`;
        rawMarkdownRef.current = edited;
        rerender({ ...params, rawMarkdown: edited });
        // Nothing to offer: running it could only fail.
        expect(result.current.canUndoDelete).toBe(false);
        setRawMarkdown.mockClear();
        saveFile.mockClear();

        let handled = false;
        act(() => {
          handled = result.current.undoLastDelete();
        });

        // Handled, so the key press still says why nothing came back.
        expect(handled).toBe(true);
        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenLastCalledWith(UNDO_ERROR, 'error');
        showToast.mockClear();

        let again = true;
        act(() => {
          again = result.current.undoLastDelete();
        });
        expect(again).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
      });

      it('leaves the delete alone while another file is open, and undoes it back on its own file', () => {
        const { result, rerender, params, setRawMarkdown, showToast, rawMarkdownRef } =
          setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        const afterDelete = rawMarkdownRef.current;
        showToast.mockClear();
        setRawMarkdown.mockClear();

        rawMarkdownRef.current = 'Other file';
        rerender({ ...params, activeFilePath: 'b.md', rawMarkdown: 'Other file' });
        expect(result.current.canUndoDelete).toBe(false);
        let elsewhere = true;
        act(() => {
          elsewhere = result.current.undoLastDelete();
        });
        expect(elsewhere).toBe(false);
        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();

        rawMarkdownRef.current = afterDelete;
        rerender({ ...params, activeFilePath: 'a.md', rawMarkdown: afterDelete });
        expect(result.current.canUndoDelete).toBe(true);
        let back = false;
        act(() => {
          back = result.current.undoLastDelete();
        });
        expect(back).toBe(true);
        expect(setRawMarkdown).toHaveBeenCalledWith(commentRaw);
      });

      it("the toast's Undo does nothing once the delete was undone another way", () => {
        const { result, setRawMarkdown, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        const toastUndo = undoAction(showToast);
        act(() => {
          result.current.undoLastDelete();
        });
        setRawMarkdown.mockClear();
        showToast.mockClear();

        act(() => toastUndo.onClick());

        expect(setRawMarkdown).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
      });

      it("there is nothing left to undo after the toast's Undo", () => {
        const { result, setRawMarkdown, showToast } = setup(commentRaw);

        act(() => result.current.handleDelete('c1'));
        act(() => undoAction(showToast).onClick());
        setRawMarkdown.mockClear();

        let handled = true;
        act(() => {
          handled = result.current.undoLastDelete();
        });

        expect(handled).toBe(false);
        expect(setRawMarkdown).not.toHaveBeenCalled();
      });
    });

    it('bulk Delete all stays toast-free', () => {
      const { result, showToast } = setup(commentRaw);

      act(() => result.current.handleBulkDelete());

      expect(showToast).not.toHaveBeenCalled();
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
      const { result, rerender } = renderHook((p: UseCommentsParams) => useComments(p), {
        initialProps: params,
      });
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
      const raw = `Hello ${makeComment({ id: 'c1', anchor: 'missing text', status: 'open' })}new anchor here`;
      const rawMarkdownRef = { current: raw };
      const params = defaultParams({
        rawMarkdown: raw,
        rawMarkdownRef: rawMarkdownRef as unknown as UseCommentsParams['rawMarkdownRef'],
        setRawMarkdown,
        saveFile,
      });
      const { result } = renderHook(() => useComments(params));

      act(() => result.current.handleReanchorToSelection('c1', 'new anchor', undefined));

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

      act(() => result.current.handleReanchorToSelection('c1', 'not in doc', undefined));

      const saved = setRawMarkdown.mock.calls[0][0] as string;
      expect(saved).toContain('"anchor":"missing"');
    });
  });
});
