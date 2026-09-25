// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useContextMenuItems, type UseContextMenuItemsParams } from './useContextMenuItems';
import type { SelectionInfo } from '../types';

function menu() {
  return { isOpen: false, x: 0, y: 0, open: vi.fn(), close: vi.fn() };
}

function setup(committed: SelectionInfo) {
  const viewerCtxMenu = menu();
  const params = {
    comments: [],
    enableResolve: false,
    handleResolve: vi.fn(),
    handleUnresolve: vi.fn(),
    handleDelete: vi.fn(),
    setActiveCommentId: vi.fn(),
    ensureCommentSurface: vi.fn(),
    selectionRef: { current: committed },
    adoptSelection: vi.fn(),
    copySelectionAsMarkdown: vi.fn(),
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
  return { result, viewerCtxMenu };
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
