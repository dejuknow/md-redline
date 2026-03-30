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
import { useSessionPersistence, loadSession } from './hooks/useSessionPersistence';
import { parseComments } from './lib/comment-parser';
import { getEffectiveStatus } from './types';
import { MarkdownViewer, type MarkdownViewerHandle } from './components/MarkdownViewer';
import { TableOfContents } from './components/TableOfContents';
import { CommentSidebar } from './components/CommentSidebar';
import { CommentForm } from './components/CommentForm';
import { Toolbar } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { FileExplorer } from './components/FileExplorer';
import { FileOpener } from './components/FileOpener';
import { DragHandles } from './components/DragHandles';
import { DiffViewer } from './components/DiffViewer';
import { RawView, type RawViewHandle } from './components/RawView';
import { Toast } from './components/Toast';

import { CommandPalette, type Command } from './components/CommandPalette';
import { ContextMenu } from './components/ContextMenu';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { KeyboardShortcutsPanel } from './components/KeyboardShortcutsPanel';
import { useDragHandles } from './hooks/useDragHandles';
import { useAuthor } from './hooks/useAuthor';
import { useContextMenu } from './hooks/useContextMenu';
import { useSettings } from './contexts/SettingsContext';
import { useThemePersistence } from './hooks/useThemePersistence';
import { migrateLocalStorageToDisk } from './lib/preferences-client';
import { ALL_THEMES } from './lib/themes';
import { usePaneLayout } from './hooks/usePaneLayout';
import { useToast } from './hooks/useToast';
import { useModalState } from './hooks/useModalState';
import { useSearch } from './hooks/useSearch';
import { useCommentCardTriggers } from './hooks/useCommentCardTriggers';
import { useDiffSnapshot } from './hooks/useDiffSnapshot';
import { useComments } from './hooks/useComments';
import { useHeadingTracking } from './hooks/useHeadingTracking';
import { useContextMenuItems } from './hooks/useContextMenuItems';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const modKey = isMac ? '\u2318' : 'Ctrl';
const prevTabShortcut = isMac ? '\u2318\u21e7[' : 'Ctrl+Shift+[';
const nextTabShortcut = isMac ? '\u2318\u21e7]' : 'Ctrl+Shift+]';

export default function App() {
  // Load saved session lazily (deferred to first render, not module import time)
  const [savedSession] = useState(() => loadSession());
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

  const [explorerDir, setExplorerDir] = useState<string | undefined>(undefined);
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();
  const { author, setAuthor } = useAuthor();
  const { settings } = useSettings();
  const { theme, setTheme } = useThemePersistence();
  const { explorerWidth, sidebarWidth, onResizeStart, isDragging } = useResizablePanel();
  const {
    explorerVisible,
    setExplorerVisible,
    sidebarVisible,
    setSidebarVisible,
    leftPanelView,
    setLeftPanelView,
    viewMode,
    setViewMode,
  } = usePaneLayout();

  // One-time migration of localStorage preferences to disk
  useEffect(() => {
    migrateLocalStorageToDisk();
  }, []);

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
    const params = new URLSearchParams(window.location.search);
    if (params.get('file') || params.get('dir')) return;
    if (savedSession && savedSession.openTabs.length > 0) {
      // Open inactive tabs in background first, then the active tab last
      // (openTab sets it active, avoiding the setTimeout race)
      const activeTarget =
        savedSession.activeFilePath && savedSession.openTabs.includes(savedSession.activeFilePath)
          ? savedSession.activeFilePath
          : savedSession.openTabs[0];
      for (const path of savedSession.openTabs) {
        if (path === activeTarget) continue;
        openTabInBackground(path);
      }
      openTab(activeTarget);
    }
  }, [openTab, openTabInBackground, savedSession]);

  // Toast notification state
  const { toast, showToast, dismissToast } = useToast();

  // Auto-expand comment form state (Feature 3)
  const [autoExpandForm, setAutoExpandForm] = useState(false);

  // Modal state — only one modal can be open at a time
  const { activeModal, setActiveModal, toggleModal, openFilePicker } = useModalState();

  const switchTabByOffset = useCallback(
    (offset: number) => {
      if (tabs.length === 0) return;

      const activeIndex = activeFilePath
        ? tabs.findIndex((tab) => tab.filePath === activeFilePath)
        : -1;

      const fallbackIndex = offset >= 0 ? 0 : tabs.length - 1;
      const nextIndex =
        activeIndex === -1 ? fallbackIndex : (activeIndex + offset + tabs.length) % tabs.length;

      switchTab(tabs[nextIndex].filePath);
    },
    [tabs, activeFilePath, switchTab],
  );

  // Text search state
  const showSearch = activeModal === 'search';
  const {
    searchQuery,
    activeSearchIndex,
    searchMatchCount,
    searchFocusTrigger,
    setSearchFocusTrigger,
    handleSearchCount,
    handleSearchNext,
    handleSearchPrev,
    handleSearchClose,
    handleSearchQueryChange,
    handleRawSearchCount,
  } = useSearch(() => setActiveModal(null), viewMode);

  // Platform info for context menu labels
  const [revealLabel, setRevealLabel] = useState('Reveal in File Manager');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/platform', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(({ platform }) => {
        if (platform === 'darwin') setRevealLabel('Reveal in Finder');
        else if (platform === 'win32') setRevealLabel('Show in Explorer');
        else setRevealLabel('Show in File Manager');
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Context menu state
  const viewerCtxMenu = useContextMenu();
  const explorerCtxMenu = useContextMenu();
  const tabCtxMenu = useContextMenu();
  const sidebarCtxMenu = useContextMenu();

  // Triggers for remotely entering edit/reply mode on a CommentCard
  const { requestedEditor, triggerEdit, triggerReply } = useCommentCardTriggers();

  const viewerRef = useRef<MarkdownViewerHandle>(null);
  const rawViewRef = useRef<RawViewHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref to avoid rawMarkdown in callback dependencies (stabilizes function identities).
  const rawMarkdownRef = useRef(rawMarkdown);
  useLayoutEffect(() => {
    rawMarkdownRef.current = rawMarkdown;
  }, [rawMarkdown]);

  // Diff snapshot state
  const { currentSnapshot, handleSnapshot, handleClearSnapshot } = useDiffSnapshot(
    activeFilePath,
    rawMarkdownRef,
    showToast,
    viewMode,
    setViewMode,
  );

  // Ref to access snapshot state inside callbacks without adding dependencies.
  const currentSnapshotRef = useRef(currentSnapshot);
  useLayoutEffect(() => {
    currentSnapshotRef.current = currentSnapshot;
  }, [currentSnapshot]);

  const { selection, clearSelection, lockSelection } = useSelection(
    containerRef as RefObject<HTMLElement | null>,
  );

  // Comment state and operations
  const {
    activeCommentId,
    setActiveCommentId,
    comments,
    cleanMarkdown,
    html,
    missingAnchors,
    commentCounts,
    commentCount,
    handleAddComment,
    handleResolve,
    handleUnresolve,
    handleDelete,
    handleEdit,
    handleReply,
    handleEditReply,
    handleDeleteReply,
    handleBulkDelete,
    handleBulkResolve,
    handleBulkDeleteResolved,
    handleCopyAgentPrompt,
    handleHighlightClick,
    handleSidebarActivate,
    handleAnchorChange,
    handleJumpToNext,
    handleJumpToPrev,
  } = useComments({
    rawMarkdown,
    rawMarkdownRef,
    setRawMarkdown,
    saveFile,
    author,
    enableResolve: settings.enableResolve,
    tabs,
    activeFilePath,
    viewerRef,
    rawViewRef,
    showToast,
    clearSelection,
    setAutoExpandForm,
  });

  // Combined handoff: snapshot + copy agent prompt
  const handleHandoff = useCallback(
    (filePaths: string[]) => {
      handleSnapshot();
      handleCopyAgentPrompt(filePaths);
    },
    [handleSnapshot, handleCopyAgentPrompt],
  );

  // Heading tracking / table of contents
  const { tocHeadings, activeHeadingId, setActiveHeadingId, spyDisabledRef, scrollSpyRafRef } =
    useHeadingTracking(containerRef, viewerRef, html);

  const handleHeadingNavigate = useCallback(
    (id: string) => {
      cancelAnimationFrame(scrollSpyRafRef.current);
      spyDisabledRef.current = true;
      setActiveHeadingId(id);

      if (viewMode === 'raw') {
        rawViewRef.current?.scrollToHeading(id);
        return;
      }

      const el = containerRef.current?.querySelector(`#${CSS.escape(id)}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [setActiveHeadingId, viewMode, scrollSpyRafRef, spyDisabledRef],
  );

  // Clear transient state on tab switch
  const prevFilePathRef = useRef(activeFilePath);
  useEffect(() => {
    if (prevFilePathRef.current !== activeFilePath) {
      prevFilePathRef.current = activeFilePath;
      setActiveCommentId(null);
      if (viewMode === 'diff') setViewMode('rendered');
      clearSelection();
    }
  }, [activeFilePath, viewMode, setViewMode, clearSelection, setActiveCommentId]);

  // File watcher — live reload from server SSE (Feature 8: detect status transitions)
  useFileWatcher({
    filePath: activeFilePath,
    onExternalChange: useCallback(
      (content: string) => {
        // Detect comment changes before updating
        let cleanContentChanged = false;
        try {
          const { comments: oldComments, cleanMarkdown: oldClean } = parseComments(
            rawMarkdownRef.current,
          );
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
            showToast(`${deletedCount} comment${deletedCount > 1 ? 's' : ''} addressed externally`);
          } else if (newReplyCount > 0) {
            showToast(`${newReplyCount} new repl${newReplyCount > 1 ? 'ies' : 'y'} added`);
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
      [setRawMarkdown, setViewMode, settings.enableResolve, showToast],
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
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
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
  }, [openTab, addRecentFile, setExplorerVisible, savedSession]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (path.trim()) {
        openTab(path.trim());
        addRecentFile(path.trim());
      }
    },
    [openTab, addRecentFile],
  );

  const revealInFinder = useCallback(
    (path: string) => {
      fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
        .then((r) => {
          if (!r.ok) showToast('Could not reveal file');
        })
        .catch(() => {
          showToast('Could not reveal file');
        });
    },
    [showToast],
  );

  const handleExplorerOpenFile = useCallback(
    (path: string) => {
      openTab(path.trim());
      addRecentFile(path.trim());
    },
    [openTab, addRecentFile],
  );

  const { handlePositions, onHandleMouseDown } = useDragHandles({
    viewerRef,
    scrollContainerRef: containerRef,
    activeCommentId,
    comments,
    onAnchorChange: handleAnchorChange,
  });

  // Stable ref for selection to use in keyboard handler without re-creating it
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Context menu handlers
  const {
    ctxMenuItems,
    explorerCtxMenuItems,
    tabCtxMenuItems,
    sidebarCtxMenuItems,
    handleViewerContextMenu,
    handleExplorerContextMenu,
    handleTabContextMenu,
    handleSidebarContextMenu,
  } = useContextMenuItems({
    comments,
    enableResolve: settings.enableResolve,
    templates: settings.templates,
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
  });

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
        toggleModal('commandPalette');
        return;
      }

      // Cmd+, : Open settings (works even in inputs)
      if (mod && e.key === ',') {
        e.preventDefault();
        toggleModal('settings');
        return;
      }

      // Cmd+Shift+O : Toggle outline (must come before Cmd+O)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (explorerVisible && leftPanelView === 'outline') {
          setExplorerVisible(false);
        } else {
          setExplorerVisible(true);
          setLeftPanelView('outline');
        }
        return;
      }

      // Cmd+O : Open file
      if (mod && e.key === 'o') {
        e.preventDefault();
        openFilePicker();
        return;
      }

      // Cmd+B : Toggle file explorer
      if (mod && e.key === 'b') {
        e.preventDefault();
        if (explorerVisible && leftPanelView === 'explorer') {
          setExplorerVisible(false);
        } else {
          setExplorerVisible(true);
          setLeftPanelView('explorer');
        }
        return;
      }

      // Cmd+F : Find in document
      if (mod && e.key === 'f') {
        e.preventDefault();
        setActiveModal('search');
        setSearchFocusTrigger((t) => t + 1);
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

      // Cmd+Shift+M : Start commenting on selection
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (selectionRef.current) {
          lockSelection();
        }
        return;
      }

      // Cmd+Shift+[ / ] : Switch tabs (matches VS Code / Safari)
      if (mod && e.shiftKey && !isInput && activeModal !== 'commandPalette') {
        if (e.code === 'BracketLeft') {
          e.preventDefault();
          switchTabByOffset(-1);
          return;
        }

        if (e.code === 'BracketRight') {
          e.preventDefault();
          switchTabByOffset(1);
          return;
        }
      }

      // Keys below only work outside inputs and when command palette is closed
      if (isInput || activeModal === 'commandPalette') return;

      // ? : Toggle keyboard shortcuts help
      if (e.key === '?') {
        e.preventDefault();
        toggleModal('shortcuts');
        return;
      }

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

      // D : Delete active comment
      if (key === 'd' && activeCommentId) {
        e.preventDefault();
        handleDelete(activeCommentId);
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    lockSelection,
    handleJumpToNext,
    handleJumpToPrev,
    handleAddComment,
    handleDelete,
    handleResolve,
    handleUnresolve,
    viewMode,
    activeCommentId,
    comments,
    settings.enableResolve,
    activeModal,
    toggleModal,
    handleSearchClose,
    explorerVisible,
    leftPanelView,
    openFilePicker,
    setExplorerVisible,
    setLeftPanelView,
    setSidebarVisible,
    switchTabByOffset,
    showSearch,
    setActiveModal,
    setSearchFocusTrigger,
  ]);

  // Command palette commands — split into categories for manageable dependency arrays
  const navigationCommands = useMemo(
    (): Command[] => [
      {
        id: 'next-comment',
        label: 'Jump to next comment',
        shortcut: 'N / J',
        section: 'Navigation',
        onExecute: handleJumpToNext,
      },
      {
        id: 'prev-comment',
        label: 'Jump to previous comment',
        shortcut: 'P / K',
        section: 'Navigation',
        onExecute: handleJumpToPrev,
      },
      {
        id: 'prev-tab',
        label: 'Previous tab',
        shortcut: prevTabShortcut,
        section: 'Tabs',
        onExecute: () => switchTabByOffset(-1),
      },
      {
        id: 'next-tab',
        label: 'Next tab',
        shortcut: nextTabShortcut,
        section: 'Tabs',
        onExecute: () => switchTabByOffset(1),
      },
      {
        id: 'find',
        label: 'Find in document',
        shortcut: `${modKey}+F`,
        section: 'Navigation',
        onExecute: () => {
          setActiveModal('search');
          setSearchFocusTrigger((t) => t + 1);
        },
      },
    ],
    [handleJumpToNext, handleJumpToPrev, switchTabByOffset, setActiveModal, setSearchFocusTrigger],
  );

  const viewCommands = useMemo((): Command[] => {
    const cmds: Command[] = [
      {
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        shortcut: `${modKey}+\\`,
        section: 'View',
        onExecute: () => setSidebarVisible((p) => !p),
      },
      {
        id: 'view-rendered',
        label: 'Switch to rendered view',
        section: 'View',
        onExecute: () => setViewMode('rendered'),
      },
      {
        id: 'view-raw',
        label: 'Switch to raw markdown',
        section: 'View',
        onExecute: () => setViewMode('raw'),
      },
      {
        id: 'toggle-explorer',
        label: 'Toggle file explorer',
        shortcut: `${modKey}+B`,
        section: 'View',
        onExecute: () => {
          if (explorerVisible && leftPanelView === 'explorer') {
            setExplorerVisible(false);
          } else {
            setExplorerVisible(true);
            setLeftPanelView('explorer');
          }
        },
      },
      {
        id: 'toggle-outline',
        label: 'Toggle document outline',
        shortcut: `${modKey}+Shift+O`,
        section: 'View',
        onExecute: () => {
          if (explorerVisible && leftPanelView === 'outline') {
            setExplorerVisible(false);
          } else {
            setExplorerVisible(true);
            setLeftPanelView('outline');
          }
        },
      },
    ];
    if (currentSnapshot) {
      cmds.push({
        id: 'view-diff',
        label: 'Toggle diff view',
        section: 'View',
        onExecute: () => setViewMode((m) => (m === 'diff' ? 'rendered' : 'diff')),
      });
    }
    return cmds;
  }, [
    setSidebarVisible,
    setViewMode,
    setExplorerVisible,
    setLeftPanelView,
    explorerVisible,
    leftPanelView,
    currentSnapshot,
  ]);

  const fileCommands = useMemo((): Command[] => {
    const cmds: Command[] = [
      { id: 'reload-file', label: 'Reload file', section: 'File', onExecute: reloadFile },
      {
        id: 'open-file',
        label: 'Open file',
        shortcut: `${modKey}+O`,
        section: 'File',
        onExecute: openFilePicker,
      },
    ];
    if (currentSnapshot) {
      cmds.push({
        id: 'clear-snapshot',
        label: 'Clear diff snapshot',
        section: 'File',
        onExecute: handleClearSnapshot,
      });
    }
    return cmds;
  }, [reloadFile, openFilePicker, handleClearSnapshot, currentSnapshot]);

  const generalCommands = useMemo(
    (): Command[] => [
      {
        id: 'open-settings',
        label: 'Open settings',
        shortcut: `${modKey}+,`,
        section: 'General',
        onExecute: () => setActiveModal('settings'),
      },
      {
        id: 'keyboard-shortcuts',
        label: 'Keyboard shortcuts',
        shortcut: '?',
        section: 'General',
        onExecute: () => setActiveModal('shortcuts'),
      },
      {
        id: 'theme-system',
        label: 'Theme: System',
        section: 'Theme',
        onExecute: () => setTheme('system'),
      },
      ...ALL_THEMES.map((t) => ({
        id: `theme-${t.key}`,
        label: `Theme: ${t.label}`,
        section: 'Theme',
        onExecute: () => setTheme(t.key),
      })),
    ],
    [setTheme, setActiveModal],
  );

  const commentCommands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    if (settings.enableResolve && commentCount > 0) {
      cmds.push({
        id: 'resolve-all',
        label: 'Resolve all open comments',
        section: 'Comments',
        onExecute: handleBulkResolve,
      });
    }
    if (commentCount > 0) {
      cmds.push({
        id: 'delete-all',
        label: 'Delete all comments',
        section: 'Comments',
        onExecute: handleBulkDelete,
      });
      cmds.push({
        id: 'copy-agent-prompt',
        label: 'Hand off to agent (copy instructions)',
        section: 'Comments',
        onExecute: () => activeFilePath && handleHandoff([activeFilePath]),
      });
    }
    if (activeCommentId) {
      if (settings.enableResolve) {
        const activeComment = comments.find((c) => c.id === activeCommentId);
        if (activeComment) {
          const status = getEffectiveStatus(activeComment);
          if (status === 'open') {
            cmds.push({
              id: 'resolve-active',
              label: 'Resolve active comment',
              shortcut: 'A',
              section: 'Comments',
              onExecute: () => handleResolve(activeCommentId),
            });
          }
          if (status === 'resolved') {
            cmds.push({
              id: 'unresolve-active',
              label: 'Reopen active comment',
              shortcut: 'U',
              section: 'Comments',
              onExecute: () => handleUnresolve(activeCommentId),
            });
          }
        }
      }
      cmds.push({
        id: 'delete-active',
        label: 'Delete active comment',
        shortcut: 'D',
        section: 'Comments',
        onExecute: () => handleDelete(activeCommentId),
      });
    }
    return cmds;
  }, [
    commentCount,
    settings.enableResolve,
    handleBulkDelete,
    handleBulkResolve,
    handleHandoff,
    activeFilePath,
    activeCommentId,
    comments,
    handleResolve,
    handleUnresolve,
    handleDelete,
  ]);

  const headingCommands = useMemo(
    (): Command[] =>
      tocHeadings.map((h) => ({
        id: `heading-${h.id}`,
        label: `${'\u2003'.repeat(h.level - 1)}${h.text}`,
        section: 'Headings' as const,
        onExecute: () => handleHeadingNavigate(h.id),
      })),
    [tocHeadings, handleHeadingNavigate],
  );

  const paletteCommands = useMemo(
    () => [
      ...navigationCommands,
      ...viewCommands,
      ...fileCommands,
      ...generalCommands,
      ...commentCommands,
      ...headingCommands,
    ],
    [
      navigationCommands,
      viewCommands,
      fileCommands,
      generalCommands,
      commentCommands,
      headingCommands,
    ],
  );

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
        onOpenSettings={() => setActiveModal('settings')}
      />
      <TabBar
        tabs={tabs}
        activeFilePath={activeFilePath}
        commentCounts={commentCounts}
        onSwitchTab={switchTab}
        onCloseTab={closeTab}
        onOpenFile={openFilePicker}
        onTabContextMenu={handleTabContextMenu}
        viewMode={viewMode}
        hasSnapshot={currentSnapshot !== null}
        commentCount={commentCount}
        enableResolve={settings.enableResolve}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onClearSnapshot={handleClearSnapshot}
        onSearch={() => {
          if (showSearch) {
            handleSearchClose();
          } else {
            setActiveModal('search');
            setSearchFocusTrigger((t) => t + 1);
          }
        }}
        searchActive={showSearch}
        onCopyAgentPrompt={handleHandoff}
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
            <div
              className={`h-full flex flex-col ${explorerVisible ? '' : 'invisible pointer-events-none'}`}
              aria-hidden={!explorerVisible}
              style={{ minWidth: explorerVisible ? explorerWidth : 0 }}
            >
              {/* Tab bar */}
              <div className="h-10 border-b border-border flex items-center justify-between pl-1 pr-2 shrink-0">
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => setLeftPanelView('explorer')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      leftPanelView === 'explorer'
                        ? 'bg-surface-inset text-content'
                        : 'text-content-muted hover:text-content-secondary hover:bg-tint/50'
                    }`}
                    title="File explorer"
                  >
                    <svg
                      className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                      />
                    </svg>
                    Explorer
                  </button>
                  <button
                    onClick={() => setLeftPanelView('outline')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      leftPanelView === 'outline'
                        ? 'bg-surface-inset text-content'
                        : 'text-content-muted hover:text-content-secondary hover:bg-tint/50'
                    }`}
                    title="Document outline"
                  >
                    <svg
                      className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                      />
                    </svg>
                    Outline
                  </button>
                </div>
                <button
                  onClick={() => setExplorerVisible(false)}
                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  title="Close panel"
                  aria-label="Close panel"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
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
                  onHeadingClick={handleHeadingNavigate}
                />
              )}
            </div>
          </div>
          {explorerVisible && (
            <div
              className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
              onMouseDown={(e) => onResizeStart('explorer', e)}
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
              onMouseDown={(e) => onResizeStart('sidebar', e)}
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
              <div className="h-10 border-b border-border flex items-center justify-between pl-1 pr-2 shrink-0">
                <div className="flex items-center gap-0.5">
                  <h2 className="px-2.5 py-1.5 rounded text-xs font-medium text-content flex items-center gap-1">
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                      />
                    </svg>
                    Comments
                  </h2>
                </div>
                <button
                  onClick={() => setSidebarVisible(false)}
                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  title="Close comments panel"
                  aria-label="Close comments panel"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
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
                  onEditReply={handleEditReply}
                  onDeleteReply={handleDeleteReply}
                  onBulkDelete={handleBulkDelete}
                  onBulkResolve={handleBulkResolve}
                  onBulkDeleteResolved={handleBulkDeleteResolved}
                  onContextMenu={handleSidebarContextMenu}
                  requestedEditor={requestedEditor}
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
        open={activeModal === 'commandPalette'}
        onClose={() => setActiveModal(null)}
      />

      {/* File opener */}
      <FileOpener
        open={activeModal === 'fileOpener'}
        onClose={() => setActiveModal(null)}
        onOpenFile={(path) => {
          handleOpenFile(path);
          setActiveModal(null);
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
        open={activeModal === 'settings'}
        onClose={() => setActiveModal(null)}
        author={author}
        onAuthorChange={setAuthor}
      />
      <KeyboardShortcutsPanel
        open={activeModal === 'shortcuts'}
        onClose={() => setActiveModal(null)}
        resolveEnabled={settings.enableResolve}
      />

      {/* Keyboard shortcuts hint */}
      <div className="h-6 bg-surface-secondary border-t border-border flex items-center px-4 gap-4 text-[10px] text-content-muted shrink-0">
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+K
          </kbd>{' '}
          Commands
        </span>
        <span className="ml-auto">
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            ?
          </kbd>{' '}
          Shortcuts
        </span>
      </div>
    </div>
  );
}
