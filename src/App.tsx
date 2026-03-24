import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  type RefObject,
} from 'react';
import { useTabs } from './hooks/useTabs';
import { useSelection } from './hooks/useSelection';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useFileWatcher } from './hooks/useFileWatcher';
import { useResizablePanel } from './hooks/useResizablePanel';
import {
  useSessionPersistence,
  loadSession,
} from './hooks/useSessionPersistence';
import {
  parseComments,
  insertComment,
  removeComment,
  editComment,
  updateCommentAnchor,
  addReply,
  removeAllComments,
  detectMissingAnchors,
} from './lib/comment-parser';
import { renderMarkdown } from './markdown/pipeline';
import { MarkdownViewer, type MarkdownViewerHandle, type ViewerContextMenuInfo, highlightSearchMatches } from './components/MarkdownViewer';
import { CommentSidebar, type SidebarContextMenuInfo } from './components/CommentSidebar';
import { CommentForm } from './components/CommentForm';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { TabBar, type TabContextMenuInfo } from './components/TabBar';
import { FileExplorer, type ExplorerContextMenuInfo } from './components/FileExplorer';
import { FileOpener } from './components/FileOpener';
import { DragHandles } from './components/DragHandles';
import { DiffViewer } from './components/DiffViewer';
import { Toast } from './components/Toast';
import { ReviewSummary } from './components/ReviewSummary';
import { CommandPalette, type Command } from './components/CommandPalette';
import { ContextMenu, type ContextMenuEntry, type ContextMenuItem } from './components/ContextMenu';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { useDragHandles } from './hooks/useDragHandles';
import { useAuthor } from './hooks/useAuthor';
import { useContextMenu } from './hooks/useContextMenu';
import { useSettings } from './contexts/SettingsContext';
import { useTheme } from 'next-themes';

// Load saved session for initial state
const savedSession = loadSession();

export default function App() {
  const {
    tabs,
    activeFilePath,
    rawMarkdown,
    setRawMarkdown,
    isLoading,
    error,
    lastSaved,
    openTab,
    openTabInBackground,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    switchTab,
    saveFile,
    reloadFile,
  } = useTabs();

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [explorerVisible, setExplorerVisible] = useState(
    !savedSession?.openTabs?.length
  );
  const [explorerDir, setExplorerDir] = useState<string | undefined>(undefined);
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();
  const { author, setAuthor } = useAuthor();
  const { settings } = useSettings();
  const { theme, setTheme } = useTheme();
  const { explorerWidth, sidebarWidth, onResizeStart, isDragging } = useResizablePanel();

  // Session-persisted state: initialize from saved session
  const [viewMode, setViewMode] = useState<ViewMode>(savedSession?.viewMode ?? 'rendered');
  const [sidebarVisible, setSidebarVisible] = useState(savedSession?.sidebarVisible ?? true);
  const sidebarFilter = 'all' as const;

  // Session persistence
  const { persist } = useSessionPersistence();
  // Persist session state on changes
  useEffect(() => {
    persist({
      openTabs: tabs.map((t) => t.filePath),
      activeFilePath,
      sidebarVisible,
      viewMode,
    });
  }, [tabs, activeFilePath, sidebarVisible, viewMode, persist]);

  // Restore session tabs on first mount
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    if (savedSession && savedSession.openTabs.length > 0) {
      for (const path of savedSession.openTabs) {
        openTab(path);
      }
      // Switch to the saved active tab — unless a URL ?file= param takes precedence
      const urlFile = new URLSearchParams(window.location.search).get('file');
      if (!urlFile && savedSession.activeFilePath && savedSession.openTabs.includes(savedSession.activeFilePath)) {
        setTimeout(() => switchTab(savedSession.activeFilePath!), 50);
      }
    }
  }, [openTab, switchTab]);

  // Diff snapshot state: per-file snapshots stored in a map
  const [snapshots, setSnapshots] = useState<Map<string, string>>(new Map());
  const currentSnapshot = activeFilePath ? (snapshots.get(activeFilePath) ?? null) : null;

  // External change indicator
  const [hasExternalChange, setHasExternalChange] = useState(false);

  // Toast notification state (Feature 8)
  const [toast, setToast] = useState<{ message: string; visible: boolean }>({
    message: '',
    visible: false,
  });
  const showToast = useCallback((message: string) => {
    setToast({ message, visible: true });
  }, []);
  const dismissToast = useCallback(() => {
    setToast((prev) => ({ ...prev, visible: false }));
  }, []);

  // Review summary panel (Feature 4)
  const [showReviewSummary, setShowReviewSummary] = useState(false);

  // Auto-expand comment form state (Feature 3)
  const [autoExpandForm, setAutoExpandForm] = useState(false);

  // Command palette, file opener, & settings panel state
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showFileOpener, setShowFileOpener] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Text search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0);

  // Platform info for context menu labels
  const [revealLabel, setRevealLabel] = useState('Reveal in File Manager');
  useEffect(() => {
    fetch('/api/platform').then(r => r.json()).then(({ platform }) => {
      if (platform === 'darwin') setRevealLabel('Reveal in Finder');
      else if (platform === 'win32') setRevealLabel('Show in Explorer');
      else setRevealLabel('Show in File Manager');
    }).catch(() => {});
  }, []);

  // Context menu state
  const viewerCtxMenu = useContextMenu();
  const explorerCtxMenu = useContextMenu();
  const tabCtxMenu = useContextMenu();
  const sidebarCtxMenu = useContextMenu();
  const [ctxMenuItems, setCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [explorerCtxMenuItems, setExplorerCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [tabCtxMenuItems, setTabCtxMenuItems] = useState<ContextMenuEntry[]>([]);
  const [sidebarCtxMenuItems, setSidebarCtxMenuItems] = useState<ContextMenuEntry[]>([]);

  // Triggers for remotely entering edit/reply mode on a CommentCard
  const [requestEditId, setRequestEditId] = useState<string | null>(null);
  const [requestEditToken, setRequestEditToken] = useState(0);
  const [requestReplyId, setRequestReplyId] = useState<string | null>(null);
  const [requestReplyToken, setRequestReplyToken] = useState(0);

  const triggerEdit = useCallback((commentId: string) => {
    setRequestEditId(commentId);
    setRequestEditToken(Date.now());
  }, []);

  const triggerReply = useCallback((commentId: string) => {
    setRequestReplyId(commentId);
    setRequestReplyToken(Date.now());
  }, []);

  const viewerRef = useRef<MarkdownViewerHandle>(null);
  const rawViewRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref to avoid rawMarkdown in callback dependencies (stabilizes function identities).
  const rawMarkdownRef = useRef(rawMarkdown);
  useLayoutEffect(() => {
    rawMarkdownRef.current = rawMarkdown;
  }, [rawMarkdown]);

  // Ref to access snapshot state inside callbacks without adding dependencies.
  const currentSnapshotRef = useRef(currentSnapshot);
  useLayoutEffect(() => {
    currentSnapshotRef.current = currentSnapshot;
  }, [currentSnapshot]);

  const { selection, clearSelection, lockSelection } = useSelection(
    containerRef as RefObject<HTMLElement | null>,
  );

  // Parse comments from raw markdown
  const { cleanMarkdown, comments } = useMemo(() => parseComments(rawMarkdown ?? ''), [rawMarkdown]);

  // Render markdown to HTML
  const html = useMemo(() => (cleanMarkdown ? renderMarkdown(cleanMarkdown) : ''), [cleanMarkdown]);

  // Detect missing anchors: comments whose anchor text can no longer be found in clean markdown
  const missingAnchors = useMemo(
    () => detectMissingAnchors(cleanMarkdown, comments),
    [cleanMarkdown, comments],
  );

  // Comment counts per tab (for badges)
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.filePath === activeFilePath) {
        counts.set(tab.filePath, comments.length);
      } else {
        try {
          const { comments: tabComments } = parseComments(tab.rawMarkdown);
          counts.set(tab.filePath, tabComments.length);
        } catch {
          counts.set(tab.filePath, 0);
        }
      }
    }
    return counts;
  }, [tabs, activeFilePath, comments]);

  // Clear transient state on tab switch — derive from activeFilePath change
  const [prevFilePath, setPrevFilePath] = useState(activeFilePath);
  if (prevFilePath !== activeFilePath) {
    setPrevFilePath(activeFilePath);
    setActiveCommentId(null);
    setHasExternalChange(false);
    if (viewMode === 'diff') setViewMode('rendered');
  }
  // clearSelection clears browser selection — must run as side effect
  useEffect(() => {
    clearSelection();
  }, [activeFilePath, clearSelection]);

  // File watcher — live reload from server SSE (Feature 8: detect status transitions)
  const externalChangeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useFileWatcher({
    filePath: activeFilePath,
    onExternalChange: useCallback(
      (content: string) => {
        // Detect comment changes before updating
        let cleanContentChanged = false;
        try {
          const { comments: oldComments, cleanMarkdown: oldClean } = parseComments(rawMarkdownRef.current);
          const { comments: newComments, cleanMarkdown: newClean } = parseComments(content);
          cleanContentChanged = oldClean !== newClean;
          const newById = new Map(newComments.map((c) => [c.id, c]));

          let deletedCount = 0;
          let newReplyCount = 0;
          for (const oldC of oldComments) {
            const newC = newById.get(oldC.id);
            if (!newC) {
              deletedCount++;
              continue;
            }
            const oldReplies = oldC.replies?.length ?? 0;
            const newReplies = newC.replies?.length ?? 0;
            if (newReplies > oldReplies) {
              newReplyCount += newReplies - oldReplies;
            }
          }

          if (deletedCount > 0) {
            showToast(
              `${deletedCount} comment${deletedCount > 1 ? 's' : ''} addressed externally`,
            );
          } else if (newReplyCount > 0) {
            showToast(
              `${newReplyCount} new repl${newReplyCount > 1 ? 'ies' : 'y'} added`,
            );
          }
        } catch {
          // Ignore parse errors — still update the content
        }

        setRawMarkdown(content);

        // Auto-switch to diff view when a snapshot exists and content actually changed
        if (cleanContentChanged && currentSnapshotRef.current) {
          setViewMode('diff');
        }

        setHasExternalChange(true);
        clearTimeout(externalChangeTimerRef.current);
        externalChangeTimerRef.current = setTimeout(() => setHasExternalChange(false), 3000);
      },
      [setRawMarkdown, showToast],
    ),
  });
  // Clean up the timer on unmount
  useEffect(() => {
    return () => clearTimeout(externalChangeTimerRef.current);
  }, []);

  // Load initial file/dir from URL params, CLI arg, or restored session
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlFile = params.get('file');
    const urlDir = params.get('dir');

    if (urlFile) {
      openTab(urlFile);
      addRecentFile(urlFile);
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (urlDir) {
      setExplorerDir(urlDir);
      setExplorerVisible(true);
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (savedSession && savedSession.openTabs.length > 0) return;
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        if (data.initialFile) {
          openTab(data.initialFile);
        }
        if (data.initialDir) {
          setExplorerDir(data.initialDir);
          setExplorerVisible(true);
        }
      })
      .catch(() => {});
  }, [openTab, addRecentFile]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (path.trim()) {
        openTab(path.trim());
        addRecentFile(path.trim());
      }
    },
    [openTab, addRecentFile],
  );

  const revealInFinder = useCallback((path: string) => {
    fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => {});
  }, []);

  const handleExplorerOpenFile = useCallback(
    (path: string) => {
      openTab(path.trim());
      addRecentFile(path.trim());
    },
    [openTab, addRecentFile],
  );

  const updateAndSave = useCallback(
    (newRaw: string) => {
      setRawMarkdown(newRaw);
      saveFile(newRaw);
    },
    [setRawMarkdown, saveFile],
  );

  // Feature 7: handleAddComment now accepts context for fuzzy re-matching
  const handleAddComment = useCallback(
    (anchor: string, text: string, contextBefore?: string, contextAfter?: string, hintOffset?: number) => {
      const newRaw = insertComment(
        rawMarkdownRef.current,
        anchor,
        text,
        author,
        contextBefore,
        contextAfter,
        hintOffset,
      );
      updateAndSave(newRaw);
      clearSelection();
      setAutoExpandForm(false);
    },
    [updateAndSave, clearSelection, author],
  );

  const handleDelete = useCallback(
    (id: string) => {
      updateAndSave(removeComment(rawMarkdownRef.current, id));
      setActiveCommentId((prev) => (prev === id ? null : prev));
    },
    [updateAndSave],
  );

  const handleEdit = useCallback(
    (id: string, newText: string) => {
      updateAndSave(editComment(rawMarkdownRef.current, id, newText));
    },
    [updateAndSave],
  );

  const handleReply = useCallback(
    (id: string, text: string) => {
      updateAndSave(addReply(rawMarkdownRef.current, id, text, author));
    },
    [updateAndSave, author],
  );

  const handleBulkDelete = useCallback(() => {
    updateAndSave(removeAllComments(rawMarkdownRef.current));
  }, [updateAndSave]);

  const handleHighlightClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
  }, []);

  const handleSidebarActivate = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
    viewerRef.current?.scrollToComment(commentId);
  }, []);

  const handleAnchorChange = useCallback(
    (commentIds: string[], newAnchor: string) => {
      let newRaw = rawMarkdownRef.current;
      for (const id of commentIds) {
        newRaw = updateCommentAnchor(newRaw, id, newAnchor);
      }
      updateAndSave(newRaw);
    },
    [updateAndSave],
  );

  // Take diff snapshot
  const handleSnapshot = useCallback(() => {
    if (!activeFilePath) return;
    setSnapshots((prev) => new Map(prev).set(activeFilePath, rawMarkdownRef.current));
  }, [activeFilePath]);

  // Jump to next comment
  const handleJumpToNext = useCallback(() => {
    if (comments.length === 0) return;

    const currentIdx = activeCommentId
      ? comments.findIndex((c) => c.id === activeCommentId)
      : -1;
    const nextIdx = (currentIdx + 1) % comments.length;
    const next = comments[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
  }, [comments, activeCommentId]);

  // Jump to previous comment
  const handleJumpToPrev = useCallback(() => {
    if (comments.length === 0) return;

    const currentIdx = activeCommentId
      ? comments.findIndex((c) => c.id === activeCommentId)
      : -1;
    // When currentIdx is -1 (no active) or 0 (first), wrap to last
    const prevIdx = currentIdx <= 0 ? comments.length - 1 : currentIdx - 1;
    const prev = comments[prevIdx];
    setActiveCommentId(prev.id);
    viewerRef.current?.scrollToComment(prev.id);
  }, [comments, activeCommentId]);

  const { handlePositions, onHandleMouseDown } = useDragHandles({
    viewerRef,
    scrollContainerRef: containerRef,
    activeCommentId,
    comments,
    onAnchorChange: handleAnchorChange,
  });

  const commentCount = comments.length;

  // Stable ref for selection to use in keyboard handler without re-creating it
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // --- Context menu handlers ---
  const handleViewerContextMenu = useCallback(
    (info: ViewerContextMenuInfo) => {
      // Close other context menus if open
      explorerCtxMenu.close();
      tabCtxMenu.close();
      sidebarCtxMenu.close();

      if (info.type === 'highlight' && info.commentIds?.length) {
        // Right-clicked on a comment highlight
        const commentId = info.commentIds[0];
        const comment = comments.find((c) => c.id === commentId);
        if (!comment) return;

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
        // Right-clicked on selected text
        const sel = selectionRef.current;
        if (!sel) return;

        const templateItems: ContextMenuItem[] = settings.templates.map((t) => ({
          label: t.label,
          onClick: () => {
            handleAddComment(sel.text, t.text, sel.contextBefore, sel.contextAfter);
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
    [comments, handleDelete, handleAddComment, lockSelection, triggerEdit, triggerReply, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
  );

  const handleExplorerContextMenu = useCallback(
    (info: ExplorerContextMenuInfo) => {
      viewerCtxMenu.close();
      tabCtxMenu.close();
      sidebarCtxMenu.close();

      if (info.type === 'file') {
        const items: ContextMenuEntry[] = [
          {
            label: 'Open',
            onClick: () => handleExplorerOpenFile(info.path),
          },
          {
            label: 'Open in Background Tab',
            onClick: () => {
              openTabInBackground(info.path);
              addRecentFile(info.path);
            },
          },
          { type: 'divider' as const },
          {
            label: revealLabel,
            onClick: () => revealInFinder(info.path),
          },
          {
            label: 'Copy Path',
            onClick: () => navigator.clipboard.writeText(info.path),
          },
          {
            label: 'Copy File Name',
            onClick: () => navigator.clipboard.writeText(info.name),
          },
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
          {
            label: revealLabel,
            onClick: () => revealInFinder(info.path),
          },
          {
            label: 'Copy Path',
            onClick: () => navigator.clipboard.writeText(info.path),
          },
        ];
        setExplorerCtxMenuItems(items);
        explorerCtxMenu.open(info.x, info.y);
      } else {
        // Blank space — context is the current directory
        const items: ContextMenuEntry[] = [
          {
            label: revealLabel,
            onClick: () => revealInFinder(info.path),
          },
          {
            label: 'Copy Path',
            onClick: () => navigator.clipboard.writeText(info.path),
          },
        ];
        setExplorerCtxMenuItems(items);
        explorerCtxMenu.open(info.x, info.y);
      }
    },
    [handleExplorerOpenFile, openTabInBackground, addRecentFile, revealInFinder, revealLabel, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
  );

  const handleTabContextMenu = useCallback(
    (info: TabContextMenuInfo) => {
      viewerCtxMenu.close();
      explorerCtxMenu.close();
      sidebarCtxMenu.close();

      const tabIndex = tabs.findIndex((t) => t.filePath === info.filePath);
      const hasTabsToRight = tabIndex >= 0 && tabIndex < tabs.length - 1;
      const hasOtherTabs = tabs.length > 1;
      const fileName = info.filePath.split('/').pop() || info.filePath;

      const items: ContextMenuEntry[] = [
        {
          label: 'Close',
          onClick: () => closeTab(info.filePath),
        },
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
        {
          label: 'Close All',
          onClick: () => closeAllTabs(),
        },
        { type: 'divider' as const },
        {
          label: 'Reveal in Finder',
          onClick: () => revealInFinder(info.filePath),
        },
        {
          label: 'Copy Path',
          onClick: () => navigator.clipboard.writeText(info.filePath),
        },
        {
          label: 'Copy File Name',
          onClick: () => navigator.clipboard.writeText(fileName),
        },
      ];
      setTabCtxMenuItems(items);
      tabCtxMenu.open(info.x, info.y);
    },
    [tabs, closeTab, closeOtherTabs, closeAllTabs, closeTabsToRight, revealInFinder, revealLabel, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
  );

  const handleSidebarContextMenu = useCallback(
    (info: SidebarContextMenuInfo) => {
      viewerCtxMenu.close();
      explorerCtxMenu.close();
      tabCtxMenu.close();

      const comment = comments.find((c) => c.id === info.commentId);
      if (!comment) return;

      const items: ContextMenuEntry[] = [
        {
          label: 'Delete',
          danger: true,
          onClick: () => handleDelete(info.commentId),
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
    [comments, handleDelete, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
  );

  // --- Text search callbacks ---
  const handleSearchCount = useCallback((count: number) => {
    setSearchMatchCount(count);
  }, []);

  const handleSearchNext = useCallback(() => {
    setActiveSearchIndex(prev => (prev < searchMatchCount - 1 ? prev + 1 : 0));
  }, [searchMatchCount]);

  const handleSearchPrev = useCallback(() => {
    setActiveSearchIndex(prev => (prev > 0 ? prev - 1 : Math.max(0, searchMatchCount - 1)));
  }, [searchMatchCount]);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
    setSearchMatchCount(0);
  }, []);

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setActiveSearchIndex(0);
  }, []);

  // Raw view: set textContent via ref and apply search highlights
  useLayoutEffect(() => {
    if (viewMode !== 'raw' || !rawViewRef.current) return;
    rawViewRef.current.textContent = rawMarkdown;
    if (showSearch && searchQuery) {
      const count = highlightSearchMatches(rawViewRef.current, searchQuery, activeSearchIndex);
      setSearchMatchCount(count);
    } else {
      setSearchMatchCount(0);
    }
  }, [viewMode, rawMarkdown, showSearch, searchQuery, activeSearchIndex]);

  // Reset match count in diff view (no search support)
  useEffect(() => {
    if (viewMode === 'diff') setSearchMatchCount(0);
  }, [viewMode]);

  // Stable ref for templates to use in keyboard handler
  const templatesRef = useRef(settings.templates);
  templatesRef.current = settings.templates;

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Cmd+K : Open command palette (works even in inputs)
      if (mod && e.key === 'k') {
        e.preventDefault();
        setShowFileOpener(false);
        setShowCommandPalette((prev) => !prev);
        return;
      }

      // Cmd+, : Open settings (works even in inputs)
      if (mod && e.key === ',') {
        e.preventDefault();
        setShowSettings((prev) => !prev);
        return;
      }

      // Cmd+O : Open file
      if (mod && e.key === 'o') {
        e.preventDefault();
        setShowCommandPalette(false);
        setShowFileOpener((prev) => !prev);
        return;
      }

      // Cmd+B : Toggle file explorer
      if (mod && e.key === 'b') {
        e.preventDefault();
        setExplorerVisible((prev) => !prev);
        return;
      }

      // Cmd+F : Find in document
      if (mod && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setSearchFocusTrigger(t => t + 1);
        return;
      }

      // Cmd+\ : Toggle sidebar
      if (mod && e.key === '\\') {
        e.preventDefault();
        setSidebarVisible((prev) => !prev);
        return;
      }

      // Cmd+Enter : Expand comment form when text is selected (Feature 3)
      if (mod && e.key === 'Enter' && !isInput && selectionRef.current && viewMode === 'rendered') {
        e.preventDefault();
        lockSelection();
        setAutoExpandForm(true);
        return;
      }

      // Cmd+1..8 : Quick-apply template when text is selected (Feature 3)
      if (
        mod &&
        !isInput &&
        selectionRef.current &&
        viewMode === 'rendered' &&
        e.key >= '1' &&
        e.key <= '8'
      ) {
        const idx = parseInt(e.key) - 1;
        const templates = templatesRef.current;
        if (idx < templates.length) {
          e.preventDefault();
          const sel = selectionRef.current;
          handleAddComment(sel.text, templates[idx].text, sel.contextBefore, sel.contextAfter, sel.offset);
          return;
        }
      }

      // Cmd+Shift+M : Start commenting on selection
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (selectionRef.current) {
          lockSelection();
        }
        return;
      }

      // Keys below only work outside inputs and when command palette is closed
      if (isInput || showCommandPalette) return;
      if (mod || e.shiftKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // Escape : Close search bar
      if (key === 'escape' && showSearch) {
        handleSearchClose();
        return;
      }

      // N / P : Jump to next / previous comment
      if (key === 'n') {
        e.preventDefault();
        handleJumpToNext();
        return;
      }
      if (key === 'p') {
        e.preventDefault();
        handleJumpToPrev();
        return;
      }

      // j / k : Navigate comments in sidebar (vim-style)
      if (key === 'j') {
        e.preventDefault();
        handleJumpToNext();
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        handleJumpToPrev();
        return;
      }

    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lockSelection, handleJumpToNext, handleJumpToPrev, handleAddComment, viewMode, activeCommentId, comments, showCommandPalette, showSearch, handleSearchClose]);

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const modKey = isMac ? '\u2318' : 'Ctrl';

  // Command palette commands
  const paletteCommands = useMemo((): Command[] => {
    const cmds: Command[] = [
      { id: 'next-comment', label: 'Jump to next comment', shortcut: 'N / J', section: 'Navigation', onExecute: handleJumpToNext },
      { id: 'prev-comment', label: 'Jump to previous comment', shortcut: 'P / K', section: 'Navigation', onExecute: handleJumpToPrev },
      { id: 'toggle-sidebar', label: 'Toggle sidebar', shortcut: `${modKey}+\\`, section: 'View', onExecute: () => setSidebarVisible((p) => !p) },
      { id: 'view-rendered', label: 'Switch to rendered view', section: 'View', onExecute: () => setViewMode('rendered') },
      { id: 'view-raw', label: 'Switch to raw markdown', section: 'View', onExecute: () => setViewMode('raw') },
      { id: 'reload-file', label: 'Reload file', section: 'File', onExecute: reloadFile },
      { id: 'take-snapshot', label: 'Take diff snapshot', section: 'File', onExecute: handleSnapshot },
      { id: 'open-file', label: 'Open file', shortcut: `${modKey}+O`, section: 'File', onExecute: () => setShowFileOpener(true) },
      { id: 'review-summary', label: 'Toggle review summary', section: 'View', onExecute: () => setShowReviewSummary((p) => !p) },
      { id: 'toggle-explorer', label: 'Toggle file explorer', shortcut: `${modKey}+B`, section: 'View', onExecute: () => setExplorerVisible((p) => !p) },
      { id: 'open-settings', label: 'Open settings', shortcut: `${modKey}+,`, section: 'General', onExecute: () => setShowSettings(true) },
      { id: 'find', label: 'Find in document', shortcut: `${modKey}+F`, section: 'Navigation', onExecute: () => { setShowSearch(true); setSearchFocusTrigger(t => t + 1); } },
      { id: 'theme-light', label: 'Theme: Light', section: 'Theme', onExecute: () => setTheme('light') },
      { id: 'theme-dark', label: 'Theme: Dark', section: 'Theme', onExecute: () => setTheme('dark') },
      { id: 'theme-sepia', label: 'Theme: Sepia', section: 'Theme', onExecute: () => setTheme('sepia') },
      { id: 'theme-nord', label: 'Theme: Nord', section: 'Theme', onExecute: () => setTheme('nord') },
    ];

    if (currentSnapshot) {
      cmds.push({ id: 'view-diff', label: 'Toggle diff view', section: 'View', onExecute: () => setViewMode((m) => m === 'diff' ? 'rendered' : 'diff') });
    }

    if (commentCount > 0) {
      cmds.push({ id: 'delete-all', label: 'Delete all comments', section: 'Comments', onExecute: handleBulkDelete });
    }

    if (activeCommentId) {
      cmds.push({ id: 'delete-active', label: 'Delete active comment', section: 'Comments', onExecute: () => handleDelete(activeCommentId) });
    }

    return cmds;
  }, [modKey, handleJumpToNext, handleJumpToPrev, reloadFile, handleSnapshot, currentSnapshot, commentCount, handleBulkDelete, activeCommentId, handleDelete, setTheme]);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <Toolbar
        lastSaved={lastSaved}
        error={error}
        isLoading={isLoading}
        showExplorer={explorerVisible}
        sidebarVisible={sidebarVisible}
        author={author}
        onAuthorChange={setAuthor}
        onToggleExplorer={() => setExplorerVisible((p) => !p)}
        onToggleSidebar={() => setSidebarVisible((p) => !p)}
        onOpenSettings={() => setShowSettings(true)}
        onSearch={() => { if (showSearch) { handleSearchClose(); } else { setShowSearch(true); setSearchFocusTrigger(t => t + 1); } }}
        searchActive={showSearch}
      />
      <TabBar
        tabs={tabs}
        activeFilePath={activeFilePath}
        commentCounts={commentCounts}
        onSwitchTab={(path) => {
          switchTab(path);
          setShowReviewSummary(false);
        }}
        onCloseTab={closeTab}
        onOpenFile={() => setShowFileOpener(true)}
        onTabContextMenu={handleTabContextMenu}
        viewMode={viewMode}
        hasSnapshot={currentSnapshot !== null}
        hasExternalChange={hasExternalChange}
        showReviewSummary={showReviewSummary}
        commentCount={commentCount}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onSnapshot={handleSnapshot}
        onJumpToNext={handleJumpToNext}
        onToggleReviewSummary={() => setShowReviewSummary((prev) => !prev)}
        onReload={reloadFile}
      />

      <>
          <div className="flex-1 flex min-h-0 relative">
            {/* File explorer left pane */}
            <div
              className={`border-r border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden ${
                explorerVisible ? '' : 'w-0 border-r-0'
              } ${isDragging ? '' : 'transition-[width] duration-200 ease-in-out'}`}
              style={explorerVisible ? { width: explorerWidth } : undefined}
            >
              <div className="h-full flex flex-col" style={{ minWidth: explorerWidth }}>
                <FileExplorer
                  initialDir={explorerDir}
                  activeFilePath={activeFilePath}
                  onOpenFile={handleExplorerOpenFile}
                  onClose={() => setExplorerVisible(false)}
                  onContextMenu={handleExplorerContextMenu}
                />
              </div>
            </div>
            {explorerVisible && (
              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
                onMouseDown={e => onResizeStart('explorer', e)}
              >
                <div className="absolute inset-y-0 -left-1 -right-1" />
              </div>
            )}

            {/* Markdown viewer */}
            <div className="flex-1 min-h-0 min-w-0 relative">
              {showSearch && (
                <SearchBar
                  query={searchQuery}
                  onQueryChange={handleSearchQueryChange}
                  matchCount={searchMatchCount}
                  activeIndex={activeSearchIndex}
                  onNext={handleSearchNext}
                  onPrev={handleSearchPrev}
                  onClose={handleSearchClose}
                  focusTrigger={searchFocusTrigger}
                />
              )}
              <div
                ref={containerRef}
                className="h-full overflow-y-auto px-8 py-6 lg:px-12 xl:px-16 relative"
              >
                <div className="max-w-3xl mx-auto">
                  {viewMode === 'raw' ? (
                    <pre ref={rawViewRef} className="text-sm text-content whitespace-pre-wrap break-words font-mono leading-relaxed" />
                  ) : viewMode === 'diff' && currentSnapshot ? (
                    <DiffViewer oldRaw={currentSnapshot} newRaw={rawMarkdown} />
                  ) : (
                    <>
                      <MarkdownViewer
                        ref={viewerRef}
                        html={html}
                        cleanMarkdown={cleanMarkdown}
                        comments={comments}
                        activeCommentId={activeCommentId}
                        selectionText={selection?.text ?? null}
                        selectionOffset={selection?.offset ?? null}
                        onHighlightClick={handleHighlightClick}
                        onContextMenu={handleViewerContextMenu}
                        searchQuery={showSearch ? searchQuery : undefined}
                        searchActiveIndex={activeSearchIndex}
                        onSearchCount={handleSearchCount}
                      />
                      <DragHandles
                        startPos={handlePositions?.start ?? null}
                        endPos={handlePositions?.end ?? null}
                        onMouseDown={onHandleMouseDown}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Comment sidebar */}
            {sidebarVisible && (
              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
                onMouseDown={e => onResizeStart('sidebar', e)}
              >
                <div className="absolute inset-y-0 -left-1 -right-1" />
              </div>
            )}
            <div
              className={`border-l border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden ${
                sidebarVisible ? '' : 'w-0 border-l-0'
              } ${isDragging ? '' : 'transition-[width] duration-200 ease-in-out'}`}
              style={sidebarVisible ? { width: sidebarWidth } : undefined}
            >
              <div className="h-full flex flex-col" style={{ minWidth: sidebarWidth }}>
                <div className="h-10 border-b border-border flex items-center justify-between px-4 shrink-0">
                  <h2 className="text-xs font-semibold text-content-secondary uppercase tracking-wider">
                    Comments
                  </h2>
                  <button
                    onClick={() => setSidebarVisible(false)}
                    className="p-0.5 rounded text-content-muted hover:text-content-secondary hover:bg-surface-inset transition-colors"
                    title="Close comments sidebar"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <CommentSidebar
                    comments={comments}
                    activeCommentId={activeCommentId}
                    missingAnchors={missingAnchors}
                    onActivate={handleSidebarActivate}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    onReply={handleReply}
                    onBulkDelete={handleBulkDelete}
                    onContextMenu={handleSidebarContextMenu}
                    requestEditId={requestEditId}
                    requestEditToken={requestEditToken}
                    requestReplyId={requestReplyId}
                    requestReplyToken={requestReplyToken}
                  />
                </div>
              </div>
            </div>

            {/* Review Summary popover (Feature 4) */}
            {showReviewSummary && (
              <ReviewSummary
                tabs={tabs}
                activeFilePath={activeFilePath}
                onSwitchToFile={(path) => {
                  switchTab(path);
                  setShowReviewSummary(false);
                }}
                onClose={() => setShowReviewSummary(false)}
              />
            )}
          </div>

          {/* Floating comment form (disabled in raw/diff view) */}
          {selection && viewMode === 'rendered' && (
            <CommentForm
              selection={selection}
              autoExpand={autoExpandForm}
              onSubmit={(anchor, text, ctxBefore, ctxAfter, hintOffset) => {
                handleAddComment(anchor, text, ctxBefore, ctxAfter, hintOffset);
                setAutoExpandForm(false);
              }}
              onCancel={() => {
                clearSelection();
                setAutoExpandForm(false);
              }}
              onLock={lockSelection}
            />
          )}
        </>

      {/* Toast notification (Feature 8) */}
      <Toast message={toast.message} visible={toast.visible} onDismiss={dismissToast} />

      {/* Command palette */}
      <CommandPalette
        commands={paletteCommands}
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
      />

      {/* File opener */}
      <FileOpener
        open={showFileOpener}
        onClose={() => setShowFileOpener(false)}
        onOpenFile={(path) => {
          handleOpenFile(path);
          setShowFileOpener(false);
        }}
        recentFiles={recentFiles}
        activeFilePath={activeFilePath}
        onClearRecent={clearRecentFiles}
      />

      {/* Context menus */}
      {viewerCtxMenu.isOpen && (
        <ContextMenu
          items={ctxMenuItems}
          position={viewerCtxMenu.position}
          onClose={viewerCtxMenu.close}
        />
      )}
      {explorerCtxMenu.isOpen && (
        <ContextMenu
          items={explorerCtxMenuItems}
          position={explorerCtxMenu.position}
          onClose={explorerCtxMenu.close}
        />
      )}
      {tabCtxMenu.isOpen && (
        <ContextMenu
          items={tabCtxMenuItems}
          position={tabCtxMenu.position}
          onClose={tabCtxMenu.close}
        />
      )}
      {sidebarCtxMenu.isOpen && (
        <ContextMenu
          items={sidebarCtxMenuItems}
          position={sidebarCtxMenu.position}
          onClose={sidebarCtxMenu.close}
        />
      )}

      {/* Settings panel */}
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        author={author}
        onAuthorChange={setAuthor}
      />

      {/* Keyboard shortcuts hint */}
      <div className="h-6 bg-surface-secondary border-t border-border flex items-center px-4 gap-4 text-[10px] text-content-muted shrink-0">
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+K
          </kbd>{' '}
          Commands
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+F
          </kbd>{' '}
          Find
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            N
          </kbd>{' '}
          /{' '}
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            P
          </kbd>{' '}
          Next / Prev
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            A
          </kbd>{' '}
          Resolve{' '}
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            U
          </kbd>{' '}
          Reopen
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+Enter
          </kbd>{' '}
          Comment
        </span>
      </div>
    </div>
  );
}
