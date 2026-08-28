import { useState, useCallback, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { ContextMenuEntry } from '../components/ContextMenu';
import type { ViewerContextMenuInfo, MarkdownViewerHandle } from '../components/MarkdownViewer';
import type { ExplorerContextMenuInfo } from '../components/FileExplorer';
import type { TabContextMenuInfo } from '../components/TabBar';
import type { SidebarContextMenuInfo } from '../components/CommentListSurface';
import type { MdComment, SelectionInfo } from '../types';
import { displayAnchor, getEffectiveStatus } from '../types';
import { getParentDir, getPathBasename } from '../lib/path-utils';

type ContextMenuInstance = {
  open: (x: number, y: number) => void;
  close: () => void;
};

export interface UseContextMenuItemsParams {
  comments: MdComment[];
  enableResolve: boolean;
  handleResolve: (id: string) => void;
  handleUnresolve: (id: string) => void;
  handleDelete: (id: string) => void;
  setActiveCommentId: Dispatch<SetStateAction<string | null>>;
  /**
   * Opens whichever comment surface can currently show one (the rail when it
   * fits, otherwise the comments drawer). Edit/Reply/Jump to Sidebar all set
   * activeCommentId and/or a requestedEditor that only a mounted surface
   * consumes; at a narrow width the rail cannot render regardless of
   * sidebarVisible, so bare `setSidebarVisible(true)` would strand the
   * request until some later surface mount fired it unprompted.
   */
  ensureCommentSurface: (commentId?: string) => void;
  selectionRef: RefObject<SelectionInfo | null>;
  /** Commit and lock a selection the menu captured when it opened. */
  adoptSelection: (info: SelectionInfo) => void;
  /** Put the selection on the clipboard as the document's markdown. */
  copySelectionAsMarkdown: () => void;
  setAutoExpandForm: Dispatch<SetStateAction<boolean>>;
  triggerEdit: (id: string) => void;
  triggerReply: (id: string) => void;
  viewerRef: RefObject<MarkdownViewerHandle | null>;
  handleExplorerOpenFile: (path: string) => void;
  openTabInBackground: (path: string) => void;
  addRecentFile: (path: string) => void;
  revealInFinder: (path: string) => void;
  revealLabel: string;
  /** Open the explorer panel on a directory (re-browses even if unchanged). */
  revealDirInExplorer: (dir: string, filePath?: string) => void;
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

/**
 * Put a viewer selection on the clipboard with the same two flavors the
 * Cmd/Ctrl+C path writes, so right-click Copy does not silently flatten a
 * table or a nested list that the keyboard copy would have preserved.
 * Falls back to plain text when the richer API is unavailable or rejects.
 */
function copySelectionToClipboard(sel: SelectionInfo): void {
  const writePlain = () => void navigator.clipboard.writeText(sel.text).catch(() => {});
  if (!sel.html || typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
    writePlain();
    return;
  }
  try {
    const item = new ClipboardItem({
      'text/plain': new Blob([sel.text], { type: 'text/plain' }),
      'text/html': new Blob([sel.html], { type: 'text/html' }),
    });
    navigator.clipboard.write([item]).catch(writePlain);
  } catch {
    writePlain();
  }
}

export function useContextMenuItems(params: UseContextMenuItemsParams) {
  const {
    comments,
    enableResolve,
    handleResolve,
    handleUnresolve,
    handleDelete,
    setActiveCommentId,
    ensureCommentSurface,
    selectionRef,
    adoptSelection,
    copySelectionAsMarkdown,
    setAutoExpandForm,
    triggerEdit,
    triggerReply,
    viewerRef,
    handleExplorerOpenFile,
    openTabInBackground,
    addRecentFile,
    revealInFinder,
    revealLabel,
    revealDirInExplorer,
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

  /**
   * Returns whether a menu was opened. The viewer suppresses the browser's own
   * menu only when this says yes: a right-click that opens nothing and also
   * eats the native menu is a dead gesture, with no Copy, no spellcheck and no
   * Inspect, and nothing on screen to explain it.
   */
  const handleViewerContextMenu = useCallback(
    (info: ViewerContextMenuInfo): boolean => {
      explorerCtxMenu.close();
      tabCtxMenu.close();
      sidebarCtxMenu.close();

      if (info.type === 'highlight' && info.commentIds?.length) {
        const commentId = info.commentIds[0];
        const comment = comments.find((c) => c.id === commentId);
        if (!comment) return false;

        const isResolved = enableResolve && getEffectiveStatus(comment) === 'resolved';

        // A resolved comment can be reopened, deleted or copied, but not edited
        // or replied to: every card surface hides both affordances while the
        // thread is settled (see CommentCard's isResolved gates). Resolved
        // anchors became right-clickable when they started painting a trace,
        // so offering the items here would be the only place in the app that
        // promises an action nothing can carry out.
        const threadItems: ContextMenuEntry[] = isResolved
          ? []
          : [
              {
                label: 'Edit',
                onClick: () => {
                  setActiveCommentId(commentId);
                  ensureCommentSurface(commentId);
                  triggerEdit(commentId);
                },
              },
              {
                label: 'Reply',
                onClick: () => {
                  setActiveCommentId(commentId);
                  ensureCommentSurface(commentId);
                  triggerReply(commentId);
                },
              },
            ];

        const resolveItems: ContextMenuEntry[] = enableResolve
          ? [
              // No leading rule when Edit/Reply are absent: it would open the
              // menu on a divider.
              ...(threadItems.length ? [{ type: 'divider' as const }] : []),
              isResolved
                ? { label: 'Reopen', onClick: () => handleUnresolve(commentId) }
                : { label: 'Resolve', onClick: () => handleResolve(commentId) },
            ]
          : [];

        const items: ContextMenuEntry[] = [
          ...threadItems,
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
            onClick: () => navigator.clipboard.writeText(displayAnchor(comment)),
          },
          {
            label: 'Copy Comment Text',
            onClick: () => navigator.clipboard.writeText(comment.text),
          },
          {
            label: 'Jump to Sidebar',
            onClick: () => {
              setActiveCommentId(commentId);
              ensureCommentSurface(commentId);
            },
          },
        ];

        setCtxMenuItems(items);
        viewerCtxMenu.open(info.x, info.y);
        return true;
      } else if (info.type === 'selection') {
        const sel = selectionRef.current;
        if (!sel) return false;
        // When the viewer resolved this from a live range rather than the
        // painted mark, that range has to BE the committed selection. While a
        // selection is locked a fresh drag never reaches the app, so the two
        // hold different text and every item here would act on the wrong one.
        if (info.liveText && info.liveText !== sel.text) return false;

        const items: ContextMenuEntry[] = [
          {
            label: 'Comment',
            onClick: () => {
              // The captured selection, not live state: the other items in this
              // menu already act on `sel`, and locking whatever happens to be
              // selected at click time is how a cleared selection wedged the
              // lock and made the document unselectable.
              adoptSelection(sel);
              setAutoExpandForm(true);
            },
          },
          { type: 'divider' as const },
          {
            label: 'Copy',
            onClick: () => {
              copySelectionToClipboard(sel);
            },
          },
          {
            label: 'Copy as Markdown',
            onClick: copySelectionAsMarkdown,
          },
        ];

        setCtxMenuItems(items);
        viewerCtxMenu.open(info.x, info.y);
        return true;
      }
      return false;
    },
    [
      comments,
      enableResolve,
      handleResolve,
      handleUnresolve,
      handleDelete,
      adoptSelection,
      copySelectionAsMarkdown,
      ensureCommentSurface,
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
            onClick: () => revealDirInExplorer(info.path),
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
      revealDirInExplorer,
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
      // Separator-agnostic: a Windows path has no forward slashes, and a file
      // at the POSIX root still has a parent to reveal.
      const parentDir = getParentDir(info.filePath) || null;

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
            revealDirInExplorer(parentDir, info.filePath);
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
      revealDirInExplorer,
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
        {
          label: 'Copy Anchor Text',
          onClick: () => navigator.clipboard.writeText(displayAnchor(comment)),
        },
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
