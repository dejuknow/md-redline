import { useState, useCallback, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { ContextMenuEntry, ContextMenuItem } from '../components/ContextMenu';
import type { ViewerContextMenuInfo, MarkdownViewerHandle } from '../components/MarkdownViewer';
import type { ExplorerContextMenuInfo } from '../components/FileExplorer';
import type { TabContextMenuInfo } from '../components/TabBar';
import type { SidebarContextMenuInfo } from '../components/CommentSidebar';
import type { MdComment, SelectionInfo } from '../types';
import { getEffectiveStatus } from '../types';
import { getPathBasename } from '../lib/path-utils';

type ContextMenuInstance = {
  open: (x: number, y: number) => void;
  close: () => void;
};

interface CommentTemplate {
  label: string;
  text: string;
}

export interface UseContextMenuItemsParams {
  comments: MdComment[];
  enableResolve: boolean;
  templates: CommentTemplate[];
  handleResolve: (id: string) => void;
  handleUnresolve: (id: string) => void;
  handleDelete: (id: string) => void;
  handleAddComment: (
    anchor: string,
    text: string,
    contextBefore?: string,
    contextAfter?: string,
    hintOffset?: number,
  ) => void;
  setActiveCommentId: Dispatch<SetStateAction<string | null>>;
  setSidebarVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
  selectionRef: RefObject<SelectionInfo | null>;
  lockSelection: () => void;
  setAutoExpandForm: Dispatch<SetStateAction<boolean>>;
  triggerEdit: (id: string) => void;
  triggerReply: (id: string) => void;
  viewerRef: RefObject<MarkdownViewerHandle | null>;
  handleExplorerOpenFile: (path: string) => void;
  openTabInBackground: (path: string) => void;
  addRecentFile: (path: string) => void;
  revealInFinder: (path: string) => void;
  revealLabel: string;
  setExplorerDir: Dispatch<SetStateAction<string | undefined>>;
  setExplorerVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
  tabs: Array<{ filePath: string }>;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  closeTabsToRight: (path: string) => void;
  viewerCtxMenu: ContextMenuInstance;
  explorerCtxMenu: ContextMenuInstance;
  tabCtxMenu: ContextMenuInstance;
  sidebarCtxMenu: ContextMenuInstance;
}

export function useContextMenuItems(params: UseContextMenuItemsParams) {
  const {
    comments,
    enableResolve,
    templates,
    handleResolve,
    handleUnresolve,
    handleDelete,
    handleAddComment,
    setActiveCommentId,
    setSidebarVisible,
    selectionRef,
    lockSelection,
    setAutoExpandForm,
    triggerEdit,
    triggerReply,
    viewerRef,
    handleExplorerOpenFile,
    openTabInBackground,
    addRecentFile,
    revealInFinder,
    revealLabel,
    setExplorerDir,
    setExplorerVisible,
    tabs,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    viewerCtxMenu,
    explorerCtxMenu,
    tabCtxMenu,
    sidebarCtxMenu,
  } = params;

  const [ctxMenuItems, setCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [explorerCtxMenuItems, setExplorerCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [tabCtxMenuItems, setTabCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [sidebarCtxMenuItems, setSidebarCtxMenuItems] = useState<ContextMenuEntry[]>([]);

  const handleViewerContextMenu = useCallback(
    (info: ViewerContextMenuInfo) => {
      explorerCtxMenu.close();
      tabCtxMenu.close();
      sidebarCtxMenu.close();

      if (info.type === 'highlight' && info.commentIds?.length) {
        const commentId = info.commentIds[0];
        const comment = comments.find((c) => c.id === commentId);
        if (!comment) return;

        const resolveItems: ContextMenuEntry[] = enableResolve
          ? [
              { type: 'divider' as const },
              getEffectiveStatus(comment) === 'resolved'
                ? { label: 'Reopen', onClick: () => handleUnresolve(commentId) }
                : { label: 'Resolve', onClick: () => handleResolve(commentId) },
            ]
          : [];

        const items: ContextMenuEntry[] = [
          {
            label: 'Edit',
            onClick: () => {
              setActiveCommentId(commentId);
              setSidebarVisible(true);
              triggerEdit(commentId);
            },
          },
          {
            label: 'Reply',
            onClick: () => {
              setActiveCommentId(commentId);
              setSidebarVisible(true);
              triggerReply(commentId);
            },
          },
          ...resolveItems,
          { type: 'divider' as const },
          {
            label: 'Delete',
            danger: true,
            onClick: () => handleDelete(commentId),
          },
          { type: 'divider' as const },
          {
            label: 'Copy Anchor Text',
            onClick: () => navigator.clipboard.writeText(comment.anchor),
          },
          {
            label: 'Copy Comment Text',
            onClick: () => navigator.clipboard.writeText(comment.text),
          },
          {
            label: 'Jump to Sidebar',
            onClick: () => {
              setActiveCommentId(commentId);
              setSidebarVisible(true);
            },
          },
        ];

        setCtxMenuItems(items);
        viewerCtxMenu.open(info.x, info.y);
      } else if (info.type === 'selection') {
        const sel = selectionRef.current;
        if (!sel) return;

        const templateItems: ContextMenuItem[] = templates.map((t) => ({
          label: t.label,
          onClick: () => {
            handleAddComment(sel.text, t.text, sel.contextBefore, sel.contextAfter, sel.offset);
          },
        }));

        const items: ContextMenuEntry[] = [
          {
            label: 'Comment',
            onClick: () => {
              lockSelection();
              setAutoExpandForm(true);
            },
          },
          {
            label: 'Templates',
            items: templateItems,
          },
          { type: 'divider' as const },
          {
            label: 'Copy',
            onClick: () => {
              navigator.clipboard.writeText(sel.text);
            },
          },
        ];

        setCtxMenuItems(items);
        viewerCtxMenu.open(info.x, info.y);
      }
    },
    [
      comments,
      enableResolve,
      templates,
      handleResolve,
      handleUnresolve,
      handleDelete,
      handleAddComment,
      lockSelection,
      setSidebarVisible,
      triggerEdit,
      triggerReply,
      selectionRef,
      setActiveCommentId,
      setAutoExpandForm,
      viewerCtxMenu,
      explorerCtxMenu,
      tabCtxMenu,
      sidebarCtxMenu,
    ],
  );

  const handleExplorerContextMenu = useCallback(
    (info: ExplorerContextMenuInfo) => {
      viewerCtxMenu.close();
      tabCtxMenu.close();
      sidebarCtxMenu.close();

      if (info.type === 'file') {
        const items: ContextMenuEntry[] = [
          { label: 'Open', onClick: () => handleExplorerOpenFile(info.path) },
          {
            label: 'Open in Background Tab',
            onClick: () => {
              openTabInBackground(info.path);
              addRecentFile(info.path);
            },
          },
          { type: 'divider' as const },
          { label: revealLabel, onClick: () => revealInFinder(info.path) },
          { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(info.path) },
          { label: 'Copy File Name', onClick: () => navigator.clipboard.writeText(info.name) },
        ];
        setExplorerCtxMenuItems(items);
        explorerCtxMenu.open(info.x, info.y);
      } else if (info.type === 'directory') {
        const items: ContextMenuEntry[] = [
          {
            label: 'Open in Explorer',
            onClick: () => {
              setExplorerDir(info.path);
              setExplorerVisible(true);
            },
          },
          { type: 'divider' as const },
          { label: revealLabel, onClick: () => revealInFinder(info.path) },
          { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(info.path) },
        ];
        setExplorerCtxMenuItems(items);
        explorerCtxMenu.open(info.x, info.y);
      } else {
        const items: ContextMenuEntry[] = [
          { label: revealLabel, onClick: () => revealInFinder(info.path) },
          { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(info.path) },
        ];
        setExplorerCtxMenuItems(items);
        explorerCtxMenu.open(info.x, info.y);
      }
    },
    [
      handleExplorerOpenFile,
      openTabInBackground,
      addRecentFile,
      revealInFinder,
      revealLabel,
      setExplorerVisible,
      setExplorerDir,
      viewerCtxMenu,
      explorerCtxMenu,
      tabCtxMenu,
      sidebarCtxMenu,
    ],
  );

  const handleTabContextMenu = useCallback(
    (info: TabContextMenuInfo) => {
      viewerCtxMenu.close();
      explorerCtxMenu.close();
      sidebarCtxMenu.close();

      const tabIndex = tabs.findIndex((t) => t.filePath === info.filePath);
      const hasTabsToRight = tabIndex >= 0 && tabIndex < tabs.length - 1;
      const hasOtherTabs = tabs.length > 1;
      const fileName = getPathBasename(info.filePath) || info.filePath;
      const lastSlash = info.filePath.lastIndexOf('/');
      const parentDir = lastSlash > 0 ? info.filePath.slice(0, lastSlash) : null;

      const items: ContextMenuEntry[] = [
        { label: 'Close', onClick: () => closeTab(info.filePath) },
        {
          label: 'Close Others',
          onClick: () => closeOtherTabs(info.filePath),
          disabled: !hasOtherTabs,
        },
        {
          label: 'Close Tabs to the Right',
          onClick: () => closeTabsToRight(info.filePath),
          disabled: !hasTabsToRight,
        },
        { label: 'Close All', onClick: () => closeAllTabs() },
        { type: 'divider' as const },
        {
          label: 'Reveal in Explorer Sidebar',
          disabled: parentDir === null,
          onClick: () => {
            if (parentDir === null) return;
            setExplorerDir(parentDir);
            setExplorerVisible(true);
          },
        },
        { label: revealLabel, onClick: () => revealInFinder(info.filePath) },
        { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(info.filePath) },
        { label: 'Copy File Name', onClick: () => navigator.clipboard.writeText(fileName) },
      ];
      setTabCtxMenuItems(items);
      tabCtxMenu.open(info.x, info.y);
    },
    [
      tabs,
      closeTab,
      closeOtherTabs,
      closeAllTabs,
      closeTabsToRight,
      revealInFinder,
      revealLabel,
      setExplorerDir,
      setExplorerVisible,
      viewerCtxMenu,
      explorerCtxMenu,
      tabCtxMenu,
      sidebarCtxMenu,
    ],
  );

  const handleSidebarContextMenu = useCallback(
    (info: SidebarContextMenuInfo) => {
      viewerCtxMenu.close();
      explorerCtxMenu.close();
      tabCtxMenu.close();

      const comment = comments.find((c) => c.id === info.commentId);
      if (!comment) return;

      const resolveItems: ContextMenuEntry[] = enableResolve
        ? [
            getEffectiveStatus(comment) === 'resolved'
              ? { label: 'Reopen', onClick: () => handleUnresolve(info.commentId) }
              : { label: 'Resolve', onClick: () => handleResolve(info.commentId) },
          ]
        : [];

      const items: ContextMenuEntry[] = [
        ...resolveItems,
        { label: 'Delete', danger: true, onClick: () => handleDelete(info.commentId) },
        { type: 'divider' as const },
        { label: 'Copy Anchor Text', onClick: () => navigator.clipboard.writeText(comment.anchor) },
        { label: 'Copy Comment Text', onClick: () => navigator.clipboard.writeText(comment.text) },
        { type: 'divider' as const },
        {
          label: 'Scroll to Highlight',
          onClick: () => {
            setActiveCommentId(info.commentId);
            viewerRef.current?.scrollToComment(info.commentId);
          },
        },
      ];
      setSidebarCtxMenuItems(items);
      sidebarCtxMenu.open(info.x, info.y);
    },
    [
      comments,
      enableResolve,
      handleResolve,
      handleUnresolve,
      handleDelete,
      setActiveCommentId,
      viewerRef,
      viewerCtxMenu,
      explorerCtxMenu,
      tabCtxMenu,
      sidebarCtxMenu,
    ],
  );

  return {
    ctxMenuItems,
    explorerCtxMenuItems,
    tabCtxMenuItems,
    sidebarCtxMenuItems,
    handleViewerContextMenu,
    handleExplorerContextMenu,
    handleTabContextMenu,
    handleSidebarContextMenu,
  };
}
