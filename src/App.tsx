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
  resolveComment,
  unresolveComment,
  addReply,
  removeAllComments,
  resolveAllComments,
  removeResolvedComments,
  detectMissingAnchors,
} from './lib/comment-parser';
import { getEffectiveStatus } from './types';
import { renderMarkdown } from './markdown/pipeline';
import { MarkdownViewer, type MarkdownViewerHandle, type ViewerContextMenuInfo, type TocHeading } from './components/MarkdownViewer';
import { TableOfContents } from './components/TableOfContents';
import { CommentSidebar, type SidebarContextMenuInfo } from './components/CommentSidebar';
import { CommentForm } from './components/CommentForm';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { TabBar, type TabContextMenuInfo } from './components/TabBar';
import { FileExplorer, type ExplorerContextMenuInfo } from './components/FileExplorer';
import { FileOpener } from './components/FileOpener';
import { DragHandles } from './components/DragHandles';
import { DiffViewer } from './components/DiffViewer';
import { RawView, type RawViewHandle } from './components/RawView';
import { Toast } from './components/Toast';

import { CommandPalette, type Command } from './components/CommandPalette';
import { ContextMenu, type ContextMenuEntry, type ContextMenuItem } from './components/ContextMenu';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { useDragHandles } from './hooks/useDragHandles';
import { useAuthor } from './hooks/useAuthor';
import { useContextMenu } from './hooks/useContextMenu';
import { useSettings } from './contexts/SettingsContext';
import { useTheme } from 'next-themes';
import { usePaneLayout } from './hooks/usePaneLayout';

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
  const [explorerDir, setExplorerDir] = useState<string | undefined>(undefined);
  const [tocHeadings, setTocHeadings] = useState<TocHeading[]>([]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();
  const { author, setAuthor } = useAuthor();
  const { settings } = useSettings();
  const { theme, setTheme } = useTheme();
  const { explorerWidth, sidebarWidth, onResizeStart, isDragging } = useResizablePanel();
  const {
    explorerVisible, setExplorerVisible,
    sidebarVisible, setSidebarVisible,
    leftPanelView, setLeftPanelView,
    viewMode, setViewMode,
  } = usePaneLayout();
  const sidebarFilter = 'all' as const;

  // Session persistence (tabs only — pane layout is persisted by usePaneLayout)
  const { persist } = useSessionPersistence();
  useEffect(() => {
    persist({
      openTabs: tabs.map((t) => t.filePath),
      activeFilePath,
    });
  }, [tabs, activeFilePath, persist]);

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
  const rawViewRef = useRef<RawViewHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // When true, spy is suppressed until the user manually scrolls (wheel/touch).
  const spyDisabledRef = useRef(false);
  const scrollSpyRafRef = useRef(0);

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

  // Extract headings from rendered HTML (runs after MarkdownViewer's useLayoutEffect sets innerHTML).
  // Depends on html only — heading structure doesn't change with comment/selection state.
  useEffect(() => {
    const headings = viewerRef.current?.getHeadings() ?? [];
    setTocHeadings(headings);
  }, [html]);

  // Track active heading based on scroll position.
  // Elements are queried fresh each frame because MarkdownViewer rebuilds innerHTML
  // on any prop change (activeCommentId, selection, etc.), replacing all DOM nodes.
  useEffect(() => {
    const scrollEl = containerRef.current;
    if (!scrollEl || tocHeadings.length === 0) return;
    const ids = tocHeadings.map((h) => h.id);

    const runSpy = () => {
      cancelAnimationFrame(scrollSpyRafRef.current);
      scrollSpyRafRef.current = requestAnimationFrame(() => {
        const containerTop = scrollEl.getBoundingClientRect().top;
        // 60% threshold: near-bottom headings that can only scroll to ~50% viewport
        // (due to pb-[50vh]) are still detected as the active section.
        const firstVisibleThreshold = scrollEl.clientHeight * 0.6;

        let lastAboveFoldId: string | null = null;
        let firstVisibleId: string | null = null;
        let firstVisibleTop = Infinity;
        for (const id of ids) {
          const el = scrollEl.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
          if (!el) continue;
          const elTop = el.getBoundingClientRect().top - containerTop;
          if (elTop <= 0) {
            lastAboveFoldId = id;
          } else if (elTop < firstVisibleTop) {
            firstVisibleTop = elTop;
            firstVisibleId = id;
          }
        }

        const activeId =
          firstVisibleId !== null && firstVisibleTop < firstVisibleThreshold
            ? firstVisibleId
            : (lastAboveFoldId ?? firstVisibleId);
        setActiveHeadingId(activeId);
      });
    };

    const onScroll = () => {
      // Cancel any stale rAF regardless — prevents a pending rAF from a previous
      // scroll from firing after a click has set the heading explicitly.
      cancelAnimationFrame(scrollSpyRafRef.current);
      if (spyDisabledRef.current) return;
      runSpy();
    };

    // Re-enable the spy the moment the user manually scrolls (wheel or touch).
    // This means a programmatic outline-click never races with the spy —
    // the clicked heading stays active until the user intentionally scrolls.
    const onManualScroll = () => {
      spyDisabledRef.current = false;
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    scrollEl.addEventListener('wheel', onManualScroll, { passive: true });
    scrollEl.addEventListener('touchstart', onManualScroll, { passive: true });
    runSpy(); // initial detection on load
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      scrollEl.removeEventListener('wheel', onManualScroll);
      scrollEl.removeEventListener('touchstart', onManualScroll);
      cancelAnimationFrame(scrollSpyRafRef.current);
    };
  }, [tocHeadings]);

  // Comment counts per tab (for badges)
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.filePath === activeFilePath) {
        const count = settings.enableResolve
          ? comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
          : comments.length;
        counts.set(tab.filePath, count);
      } else {
        try {
          const { comments: tabComments } = parseComments(tab.rawMarkdown);
          const count = settings.enableResolve
            ? tabComments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
            : tabComments.length;
          counts.set(tab.filePath, count);
        } catch {
          counts.set(tab.filePath, 0);
        }
      }
    }
    return counts;
  }, [tabs, activeFilePath, comments, settings.enableResolve]);

  // Clear transient state on tab switch — derive from activeFilePath change
  const [prevFilePath, setPrevFilePath] = useState(activeFilePath);
  if (prevFilePath !== activeFilePath) {
    setPrevFilePath(activeFilePath);
    setActiveCommentId(null);
    if (viewMode === 'diff') setViewMode('rendered');
  }
  // clearSelection clears browser selection — must run as side effect
  useEffect(() => {
    clearSelection();
  }, [activeFilePath, clearSelection]);

  // File watcher — live reload from server SSE (Feature 8: detect status transitions)
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
          let resolvedCount = 0;
          let newReplyCount = 0;
          for (const oldC of oldComments) {
            const newC = newById.get(oldC.id);
            if (!newC) {
              deletedCount++;
              continue;
            }
            if (settings.enableResolve) {
              const oldStatus = getEffectiveStatus(oldC);
              const newStatus = getEffectiveStatus(newC);
              if (oldStatus === 'open' && newStatus === 'resolved') {
                resolvedCount++;
              }
            }
            const oldReplies = oldC.replies?.length ?? 0;
            const newReplies = newC.replies?.length ?? 0;
            if (newReplies > oldReplies) {
              newReplyCount += newReplies - oldReplies;
            }
          }

          if (resolvedCount > 0) {
            showToast(
              `${resolvedCount} comment${resolvedCount > 1 ? 's' : ''} resolved externally`,
            );
          } else if (deletedCount > 0) {
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

      },
      [setRawMarkdown, showToast],
    ),
  });

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

  const handleResolve = useCallback(
    (id: string) => {
      updateAndSave(resolveComment(rawMarkdownRef.current, id));
    },
    [updateAndSave],
  );

  const handleUnresolve = useCallback(
    (id: string) => {
      updateAndSave(unresolveComment(rawMarkdownRef.current, id));
    },
    [updateAndSave],
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

  const handleBulkResolve = useCallback(() => {
    updateAndSave(resolveAllComments(rawMarkdownRef.current));
  }, [updateAndSave]);

  const handleBulkDeleteResolved = useCallback(() => {
    updateAndSave(removeResolvedComments(rawMarkdownRef.current));
  }, [updateAndSave]);

  const handleCopyAgentPrompt = useCallback((filePaths: string[]) => {
    if (filePaths.length === 0) return;

    const afterAction = settings.enableResolve
      ? 'After addressing a comment, **resolve it** by setting `"status":"resolved"` and `"resolved":true` in the marker JSON'
      : 'After addressing a comment, **remove the entire `<!-- @comment{...} -->` marker** from the file';

    const isSingle = filePaths.length === 1;
    const fileRef = isSingle ? filePaths[0] : 'the files listed below';
    const fileList = isSingle
      ? ''
      : '\n\n## Files to review\n' + filePaths.map((p, i) => {
          const count = commentCounts.get(p) ?? 0;
          return `${i + 1}. ${p} (${count} comment${count !== 1 ? 's' : ''})`;
        }).join('\n');

    const prompt = `I've left review comments in ${fileRef} using inline comment markers. Please read ${isSingle ? 'the file' : 'each file'} and address them.${fileList}

## Comment format

Comments are embedded as HTML comment markers: \`<!-- @comment{JSON} -->\`
Each marker is placed **immediately before** the text it refers to (the "anchor").
The JSON contains these fields:
- \`anchor\`: the exact text the comment refers to
- \`text\`: my feedback — this is what I need you to address
- \`replies\`: threaded discussion — read for additional context

## What to do

1. ${isSingle ? `Read ${filePaths[0]}` : 'For each file listed above,'} find all \`<!-- @comment{...} -->\` markers
2. For each comment, read the \`text\` field and address the feedback by editing the document
3. ${afterAction}
4. If a comment is unclear or you're unsure how to address it, leave the marker in place and ask me about it

## How to respond

After you're done, give me a brief summary:
- How many comments you addressed${isSingle ? '' : ' (grouped by file)'}
- For each one, a one-line description of what you changed
- Any comments you left in place and why`;

    const fileCount = filePaths.length;
    navigator.clipboard.writeText(prompt).then(
      () => showToast(`Copied agent instructions for ${fileCount} file${fileCount !== 1 ? 's' : ''}`),
      () => showToast("Couldn't copy to clipboard. Try from localhost."),
    );
  }, [commentCounts, showToast, settings.enableResolve]);

  const handleHighlightClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
  }, []);

  const handleSidebarActivate = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
    viewerRef.current?.scrollToComment(commentId);
    rawViewRef.current?.scrollToComment(commentId);
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

  // Jump to next comment (skip resolved when resolve is enabled)
  const handleJumpToNext = useCallback(() => {
    const navigable = settings.enableResolve
      ? comments.filter((c) => getEffectiveStatus(c) === 'open')
      : comments;
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId
      ? navigable.findIndex((c) => c.id === activeCommentId)
      : -1;
    const nextIdx = (currentIdx + 1) % navigable.length;
    const next = navigable[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
  }, [comments, activeCommentId, settings.enableResolve]);

  // Jump to previous comment
  const handleJumpToPrev = useCallback(() => {
    const navigable = settings.enableResolve
      ? comments.filter((c) => getEffectiveStatus(c) === 'open')
      : comments;
    if (navigable.length === 0) return;

    const currentIdx = activeCommentId
      ? navigable.findIndex((c) => c.id === activeCommentId)
      : -1;
    const prevIdx = currentIdx <= 0 ? navigable.length - 1 : currentIdx - 1;
    const prev = navigable[prevIdx];
    setActiveCommentId(prev.id);
    viewerRef.current?.scrollToComment(prev.id);
  }, [comments, activeCommentId, settings.enableResolve]);

  const { handlePositions, onHandleMouseDown } = useDragHandles({
    viewerRef,
    scrollContainerRef: containerRef,
    activeCommentId,
    comments,
    onAnchorChange: handleAnchorChange,
  });

  const commentCount = settings.enableResolve
    ? comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length
    : comments.length;

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

        const resolveItems: ContextMenuEntry[] = settings.enableResolve
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
    [comments, settings.enableResolve, handleResolve, handleUnresolve, handleDelete, handleAddComment, lockSelection, triggerEdit, triggerReply, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
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

      const resolveItems: ContextMenuEntry[] = settings.enableResolve
        ? [
            getEffectiveStatus(comment) === 'resolved'
              ? { label: 'Reopen', onClick: () => handleUnresolve(info.commentId) }
              : { label: 'Resolve', onClick: () => handleResolve(info.commentId) },
          ]
        : [];

      const items: ContextMenuEntry[] = [
        ...resolveItems,
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
    [comments, settings.enableResolve, handleResolve, handleUnresolve, handleDelete, viewerCtxMenu, explorerCtxMenu, tabCtxMenu, sidebarCtxMenu],
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

  // Raw view search count callback
  const handleRawSearchCount = useCallback((count: number) => {
    setSearchMatchCount(count);
  }, []);

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

      // Cmd+Shift+O : Toggle outline view in left panel (must come before Cmd+O)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (!explorerVisible) {
          setExplorerVisible(true);
          setLeftPanelView('outline');
        } else if (leftPanelView === 'explorer') {
          setLeftPanelView('outline');
        } else {
          setExplorerVisible(false);
          setLeftPanelView('explorer');
        }
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

      // A/X : Resolve active comment (only when resolve enabled)
      if ((key === 'a' || key === 'x') && activeCommentId && settings.enableResolve) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'open') {
          e.preventDefault();
          handleResolve(activeCommentId);
        }
        return;
      }

      // U : Unresolve/reopen active comment (only when resolve enabled)
      if (key === 'u' && activeCommentId && settings.enableResolve) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'resolved') {
          e.preventDefault();
          handleUnresolve(activeCommentId);
        }
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lockSelection, handleJumpToNext, handleJumpToPrev, handleAddComment, handleResolve, handleUnresolve, viewMode, activeCommentId, comments, settings.enableResolve, showCommandPalette, showSearch, handleSearchClose, explorerVisible, leftPanelView]);

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

      { id: 'toggle-explorer', label: 'Toggle file explorer', shortcut: `${modKey}+B`, section: 'View', onExecute: () => setExplorerVisible((p) => !p) },
      { id: 'toggle-outline', label: 'Toggle document outline', shortcut: `${modKey}+Shift+O`, section: 'View', onExecute: () => {
        if (!explorerVisible) { setExplorerVisible(true); setLeftPanelView('outline'); }
        else if (leftPanelView === 'explorer') { setLeftPanelView('outline'); }
        else { setExplorerVisible(false); setLeftPanelView('explorer'); }
      } },
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

    if (settings.enableResolve && commentCount > 0) {
      cmds.push({ id: 'resolve-all', label: 'Resolve all open comments', section: 'Comments', onExecute: handleBulkResolve });
    }
    if (commentCount > 0) {
      cmds.push({ id: 'delete-all', label: 'Delete all comments', section: 'Comments', onExecute: handleBulkDelete });
      cmds.push({ id: 'copy-agent-prompt', label: 'Hand off to agent (copy instructions)', section: 'Comments', onExecute: () => activeFilePath && handleCopyAgentPrompt([activeFilePath]) });
    }

    if (activeCommentId) {
      if (settings.enableResolve) {
        const activeComment = comments.find((c) => c.id === activeCommentId);
        if (activeComment) {
          const status = getEffectiveStatus(activeComment);
          if (status === 'open') {
            cmds.push({ id: 'resolve-active', label: 'Resolve active comment', shortcut: 'A', section: 'Comments', onExecute: () => handleResolve(activeCommentId) });
          }
          if (status === 'resolved') {
            cmds.push({ id: 'unresolve-active', label: 'Reopen active comment', shortcut: 'U', section: 'Comments', onExecute: () => handleUnresolve(activeCommentId) });
          }
        }
      }
      cmds.push({ id: 'delete-active', label: 'Delete active comment', section: 'Comments', onExecute: () => handleDelete(activeCommentId) });
    }

    // Heading navigation entries
    for (const h of tocHeadings) {
      const indent = '\u2003'.repeat(h.level - 1);
      cmds.push({
        id: `heading-${h.id}`,
        label: `${indent}${h.text}`,
        section: 'Headings',
        onExecute: () => {
          const el = containerRef.current?.querySelector(`#${CSS.escape(h.id)}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      });
    }

    return cmds;
  }, [modKey, handleJumpToNext, handleJumpToPrev, reloadFile, handleSnapshot, currentSnapshot, commentCount, settings.enableResolve, handleBulkDelete, handleBulkResolve, handleCopyAgentPrompt, activeFilePath, activeCommentId, comments, handleResolve, handleUnresolve, handleDelete, setTheme, tocHeadings, explorerVisible, leftPanelView]);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <Toolbar
        error={error}
        isLoading={isLoading}
        showExplorer={explorerVisible}
        sidebarVisible={sidebarVisible}
        author={author}
        onAuthorChange={setAuthor}
        onToggleExplorer={() => setExplorerVisible((p) => !p)}
        onToggleSidebar={() => setSidebarVisible((p) => !p)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <TabBar
        tabs={tabs}
        activeFilePath={activeFilePath}
        commentCounts={commentCounts}
        onSwitchTab={switchTab}
        onCloseTab={closeTab}
        onOpenFile={() => setShowFileOpener(true)}
        onTabContextMenu={handleTabContextMenu}
        viewMode={viewMode}
        hasSnapshot={currentSnapshot !== null}
        commentCount={commentCount}
        enableResolve={settings.enableResolve}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onSnapshot={handleSnapshot}
        onJumpToNext={handleJumpToNext}
        onSearch={() => { if (showSearch) { handleSearchClose(); } else { setShowSearch(true); setSearchFocusTrigger(t => t + 1); } }}
        searchActive={showSearch}
        onCopyAgentPrompt={handleCopyAgentPrompt}
      />

      <>
          <div className="flex-1 flex min-h-0 relative">
            {/* Left pane (Explorer / Outline) */}
            <div
              className={`border-r border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden ${
                explorerVisible ? '' : 'w-0 border-r-0'
              } ${isDragging ? '' : 'transition-[width] duration-200 ease-in-out'}`}
              style={explorerVisible ? { width: explorerWidth } : undefined}
            >
              <div className="h-full flex flex-col" style={{ minWidth: explorerWidth }}>
                {/* Tab bar */}
                <div className="h-10 border-b border-border flex items-center justify-between px-1 shrink-0">
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => setLeftPanelView('explorer')}
                      className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                        leftPanelView === 'explorer'
                          ? 'bg-surface-inset text-content'
                          : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset/50'
                      }`}
                      title="File explorer"
                    >
                      <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                      </svg>
                      Explorer
                    </button>
                    <button
                      onClick={() => setLeftPanelView('outline')}
                      className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                        leftPanelView === 'outline'
                          ? 'bg-surface-inset text-content'
                          : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset/50'
                      }`}
                      title="Document outline"
                    >
                      <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                      </svg>
                      Outline
                    </button>
                  </div>
                  <button
                    onClick={() => setExplorerVisible(false)}
                    className="p-0.5 rounded text-content-muted hover:text-content-secondary hover:bg-surface-inset transition-colors"
                    title="Close panel"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {/* Panel content */}
                {leftPanelView === 'explorer' ? (
                  <FileExplorer
                    initialDir={explorerDir}
                    activeFilePath={activeFilePath}
                    onOpenFile={handleExplorerOpenFile}
                    onClose={() => setExplorerVisible(false)}
                    onContextMenu={handleExplorerContextMenu}
                    hideHeader
                  />
                ) : (
                  <TableOfContents
                    headings={tocHeadings}
                    activeHeadingId={activeHeadingId}
                    onHeadingClick={(id) => {
                      // Cancel any pending spy rAF so it can't override the heading
                      // we're setting. Spy stays disabled until the user manually
                      // scrolls (wheel/touch), so the clicked heading is never
                      // overridden regardless of scroll distance or animation duration.
                      cancelAnimationFrame(scrollSpyRafRef.current);
                      spyDisabledRef.current = true;
                      setActiveHeadingId(id);
                      const el = containerRef.current?.querySelector(`#${CSS.escape(id)}`);
                      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  />
                )}
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
                className="h-full overflow-y-auto px-8 pt-6 pb-[50vh] lg:px-12 xl:px-16 relative"
              >
                <div className="max-w-3xl mx-auto">
                  {viewMode === 'raw' ? (
                    <RawView
                      ref={rawViewRef}
                      rawMarkdown={rawMarkdown}
                      searchQuery={showSearch ? searchQuery : undefined}
                      searchActiveIndex={activeSearchIndex}
                      onSearchCount={handleRawSearchCount}
                      activeCommentId={activeCommentId}
                    />
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
                        enableResolve={settings.enableResolve}
                        searchQuery={showSearch ? searchQuery : undefined}
                        searchActiveIndex={activeSearchIndex}
                        onSearchCount={handleSearchCount}
                        theme={theme}
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
                    onResolve={handleResolve}
                    onUnresolve={handleUnresolve}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    onReply={handleReply}
                    onBulkDelete={handleBulkDelete}
                    onBulkResolve={handleBulkResolve}
                    onBulkDeleteResolved={handleBulkDeleteResolved}
                    onContextMenu={handleSidebarContextMenu}
                    requestEditId={requestEditId}
                    requestEditToken={requestEditToken}
                    requestReplyId={requestReplyId}
                    requestReplyToken={requestReplyToken}
                  />
                </div>
              </div>
            </div>


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
        {settings.enableResolve && (
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
        )}
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+Enter
          </kbd>{' '}
          Comment
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+Shift+O
          </kbd>{' '}
          Outline
        </span>
      </div>
    </div>
  );
}
