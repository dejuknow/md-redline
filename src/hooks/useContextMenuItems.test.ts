// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useContextMenuItems, type UseContextMenuItemsParams } from './useContextMenuItems';
import type { MdComment, SelectionInfo } from '../types';

function menu() {
  return { isOpen: false, x: 0, y: 0, open: vi.fn(), close: vi.fn() };
}

function setup(
  committed: SelectionInfo,
  selectionAsMarkdown = vi.fn(() => null as string | null),
  comments: MdComment[] = [],
) {
  const viewerCtxMenu = menu();
  const params = {
    comments,
    enableResolve: false,
    handleResolve: vi.fn(),
    handleUnresolve: vi.fn(),
    handleDelete: vi.fn(),
    setActiveCommentId: vi.fn(),
    ensureCommentSurface: vi.fn(),
    selectionRef: { current: committed },
    adoptSelection: vi.fn(),
    selectionAsMarkdown,
    setAutoExpandForm: vi.fn(),
    triggerEdit: vi.fn(),
    triggerReply: vi.fn(),
    viewerRef: { current: null },
    handleExplorerOpenFile: vi.fn(),
    openTabInBackground: vi.fn(),
    addRecentFile: vi.fn(),
    revealInFinder: vi.fn(),
    revealLabel: 'Reveal',
    revealDirInExplorer: vi.fn(),
    tabs: [],
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    closeTabsToRight: vi.fn(),
    viewerCtxMenu,
    explorerCtxMenu: menu(),
    tabCtxMenu: menu(),
    sidebarCtxMenu: menu(),
  } as unknown as UseContextMenuItemsParams;
  const { result } = renderHook(() => useContextMenuItems(params));
  return { result, viewerCtxMenu, params };
}

describe('the selection menu over a live range (#87)', () => {
  const committed = {
    text: 'phrase repeated twice',
    offset: 12,
    contextBefore: '',
    contextAfter: '',
  } as unknown as SelectionInfo;

  it('opens when the live range is the committed selection', () => {
    const { result, viewerCtxMenu } = setup(committed);
    const opened = result.current.handleViewerContextMenu({
      type: 'selection',
      liveText: 'phrase repeated twice',
      liveOffset: 12,
      x: 0,
      y: 0,
    });
    expect(opened).toBe(true);
    expect(viewerCtxMenu.open).toHaveBeenCalled();
  });

  it('refuses the same words at another place, so it never acts on the first copy', () => {
    const { result, viewerCtxMenu } = setup(committed);
    const opened = result.current.handleViewerContextMenu({
      type: 'selection',
      liveText: 'phrase repeated twice',
      liveOffset: 480,
      x: 0,
      y: 0,
    });
    expect(opened).toBe(false);
    expect(viewerCtxMenu.open).not.toHaveBeenCalled();
  });
});

describe('Copy as Markdown in the selection menu (#101)', () => {
  const committed = {
    text: 'phrase repeated twice',
    offset: 12,
    contextBefore: '',
    contextAfter: '',
  } as unknown as SelectionInfo;

  type Hook = { current: ReturnType<typeof useContextMenuItems> };

  function copyItem(result: Hook) {
    act(() => {
      result.current.handleViewerContextMenu({ type: 'selection', x: 0, y: 0 });
    });
    return result.current.ctxMenuItems.find(
      (item) => (item as { label?: string }).label === 'Copy as Markdown',
    ) as { onClick: () => void } | undefined;
  }

  it('copies the markdown resolved when the menu opened, even once the selection is gone', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const selectionAsMarkdown = vi.fn(() => '- the **list**' as string | null);
    const { result } = setup(committed, selectionAsMarkdown);
    const item = copyItem(result);

    // A repaint or the tap itself has taken the live range by the click.
    selectionAsMarkdown.mockReturnValue(null);
    item!.onClick();
    expect(writeText).toHaveBeenCalledWith('- the **list**');
  });

  it('leaves the item out when there is nothing to copy', () => {
    const { result } = setup(committed);
    expect(copyItem(result)).toBeUndefined();
  });
});

describe('the highlight menu on a comment the agent wrote (#174)', () => {
  const comment = (agentInitiated: boolean): MdComment => ({
    id: 'c1',
    anchor: 'cached per tenant',
    text: 'Should this be per tenant or global?',
    author: agentInitiated ? 'Claude' : 'Alice',
    timestamp: new Date().toISOString(),
    agentInitiated,
  });

  function labels(comments: MdComment[]) {
    const { result } = setup({} as SelectionInfo, undefined, comments);
    act(() => {
      result.current.handleViewerContextMenu({ type: 'highlight', commentIds: ['c1'], x: 0, y: 0 });
    });
    return result.current.ctxMenuItems.map((item) => (item as { label?: string }).label);
  }

  it('offers no Edit, but keeps Reply and Delete', () => {
    const items = labels([comment(true)]);
    expect(items).not.toContain('Edit');
    expect(items).toContain('Reply');
    expect(items).toContain('Delete');
  });

  it('keeps Edit on the reader’s own comment', () => {
    expect(labels([comment(false)])).toContain('Edit');
  });
});
