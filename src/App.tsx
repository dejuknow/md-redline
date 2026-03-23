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
import {
  useSessionPersistence,
  loadSession,
  type FilterMode,
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
  resolveAllComments,
  removeResolvedComments,
  detectMissingAnchors,
} from './lib/comment-parser';
import { renderMarkdown } from './markdown/pipeline';
import { MarkdownViewer, type MarkdownViewerHandle } from './components/MarkdownViewer';
import { CommentSidebar } from './components/CommentSidebar';
import { CommentForm, TEMPLATES } from './components/CommentForm';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { FileBrowser } from './components/FileBrowser';
import { FileExplorer } from './components/FileExplorer';
import { DragHandles } from './components/DragHandles';
import { DiffViewer } from './components/DiffViewer';
import { Toast } from './components/Toast';
import { ReviewSummary } from './components/ReviewSummary';
import { CommandPalette, type Command } from './components/CommandPalette';
import { useDragHandles } from './hooks/useDragHandles';
import { useAuthor } from './hooks/useAuthor';
import { getEffectiveStatus } from './types';

// Load saved session for initial state
const savedSession = loadSession();

export default function App() {
  const {
    tabs,
    activeFilePath,
    filePath,
    rawMarkdown,
    setRawMarkdown,
    isLoading,
    error,
    lastSaved,
    openTab,
    closeTab,
    switchTab,
    saveFile,
    reloadFile,
  } = useTabs();

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [inputPath, setInputPath] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(false);
  const [explorerDir, setExplorerDir] = useState<string | undefined>(undefined);
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();
  const { author, setAuthor } = useAuthor();

  // Session-persisted state: initialize from saved session
  const [viewMode, setViewMode] = useState<ViewMode>(savedSession?.viewMode ?? 'rendered');
  const [sidebarVisible, setSidebarVisible] = useState(savedSession?.sidebarVisible ?? true);
  const [sidebarFilter, setSidebarFilter] = useState<FilterMode>(
    savedSession?.sidebarFilter ?? 'all',
  );

  // Session persistence
  const { persist } = useSessionPersistence();
  // Persist session state on changes
  useEffect(() => {
    persist({
      openTabs: tabs.map((t) => t.filePath),
      activeFilePath,
      sidebarVisible,
      sidebarFilter,
      viewMode,
    });
  }, [tabs, activeFilePath, sidebarVisible, sidebarFilter, viewMode, persist]);

  // Restore session tabs on first mount
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    if (savedSession && savedSession.openTabs.length > 0) {
      for (const path of savedSession.openTabs) {
        openTab(path);
      }
      if (savedSession.activeFilePath && savedSession.openTabs.includes(savedSession.activeFilePath)) {
        // openTab already switches to the last opened; switch to the saved active
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

  // Command palette state
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const viewerRef = useRef<MarkdownViewerHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref to avoid rawMarkdown in callback dependencies (stabilizes function identities).
  const rawMarkdownRef = useRef(rawMarkdown);
  useLayoutEffect(() => {
    rawMarkdownRef.current = rawMarkdown;
  }, [rawMarkdown]);

  const { selection, clearSelection, lockSelection } = useSelection(
    containerRef as RefObject<HTMLElement | null>,
  );

  // Parse comments from raw markdown
  const { cleanMarkdown, comments } = useMemo(() => parseComments(rawMarkdown), [rawMarkdown]);

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
        counts.set(
          tab.filePath,
          comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length,
        );
      } else {
        try {
          const { comments: tabComments } = parseComments(tab.rawMarkdown);
          counts.set(
            tab.filePath,
            tabComments.filter((c) => getEffectiveStatus(c) !== 'resolved').length,
          );
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
        // Feature 8: Detect comment status transitions before updating
        try {
          const { comments: oldComments } = parseComments(rawMarkdownRef.current);
          const { comments: newComments } = parseComments(content);
          const newById = new Map(newComments.map((c) => [c.id, c]));

          let resolvedCount = 0;
          let newReplyCount = 0;
          for (const oldC of oldComments) {
            const oldStatus = getEffectiveStatus(oldC);
            const newC = newById.get(oldC.id);
            if (!newC) continue;
            const newStatus = getEffectiveStatus(newC);
            if (oldStatus === 'open' && newStatus === 'resolved') {
              resolvedCount++;
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
          } else if (newReplyCount > 0) {
            showToast(
              `${newReplyCount} new repl${newReplyCount > 1 ? 'ies' : 'y'} added`,
            );
          }
        } catch {
          // Ignore parse errors — still update the content
        }

        setRawMarkdown(content);
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
      setInputPath(urlFile);
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
          setInputPath(data.initialFile);
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
        setInputPath(path);
        openTab(path.trim());
        addRecentFile(path.trim());
        setShowBrowser(false);
      }
    },
    [openTab, addRecentFile],
  );

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
    (anchor: string, text: string, contextBefore?: string, contextAfter?: string) => {
      const newRaw = insertComment(
        rawMarkdownRef.current,
        anchor,
        text,
        author,
        contextBefore,
        contextAfter,
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

  const handleBulkResolve = useCallback(() => {
    updateAndSave(resolveAllComments(rawMarkdownRef.current));
  }, [updateAndSave]);

  const handleBulkDeleteResolved = useCallback(() => {
    updateAndSave(removeResolvedComments(rawMarkdownRef.current));
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

  // Jump to next open comment
  const handleJumpToNext = useCallback(() => {
    const unresolvedComments = comments.filter((c) => getEffectiveStatus(c) === 'open');
    if (unresolvedComments.length === 0) return;

    const currentIdx = activeCommentId
      ? unresolvedComments.findIndex((c) => c.id === activeCommentId)
      : -1;
    const nextIdx = (currentIdx + 1) % unresolvedComments.length;
    const next = unresolvedComments[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
  }, [comments, activeCommentId]);

  // Jump to previous open comment
  const handleJumpToPrev = useCallback(() => {
    const unresolvedComments = comments.filter((c) => getEffectiveStatus(c) === 'open');
    if (unresolvedComments.length === 0) return;

    const currentIdx = activeCommentId
      ? unresolvedComments.findIndex((c) => c.id === activeCommentId)
      : -1;
    // When currentIdx is -1 (no active) or 0 (first), wrap to last
    const prevIdx = currentIdx <= 0 ? unresolvedComments.length - 1 : currentIdx - 1;
    const prev = unresolvedComments[prevIdx];
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

  const openCommentCount = comments.filter((c) => getEffectiveStatus(c) !== 'resolved').length;

  // Stable ref for selection to use in keyboard handler without re-creating it
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

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
        setShowCommandPalette((prev) => !prev);
        return;
      }

      // Cmd+B : Toggle file explorer
      if (mod && e.key === 'b') {
        e.preventDefault();
        setExplorerVisible((prev) => !prev);
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
        if (idx < TEMPLATES.length) {
          e.preventDefault();
          const sel = selectionRef.current;
          handleAddComment(sel.text, TEMPLATES[idx].text, sel.contextBefore, sel.contextAfter);
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

      // A : Address/resolve active comment
      if (key === 'a' && activeCommentId) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'open') {
          e.preventDefault();
          handleResolve(activeCommentId);
        }
        return;
      }

      // X : Accept/resolve active comment (same as A for this status model)
      if (key === 'x' && activeCommentId) {
        const comment = comments.find((c) => c.id === activeCommentId);
        if (comment && getEffectiveStatus(comment) === 'open') {
          e.preventDefault();
          handleResolve(activeCommentId);
        }
        return;
      }

      // U : Unresolve/reopen active comment
      if (key === 'u' && activeCommentId) {
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
  }, [lockSelection, handleJumpToNext, handleJumpToPrev, handleAddComment, handleResolve, handleUnresolve, viewMode, activeCommentId, comments, showCommandPalette]);

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
      { id: 'open-file', label: 'Open file browser', section: 'File', onExecute: () => setShowBrowser(true) },
      { id: 'review-summary', label: 'Toggle review summary', section: 'View', onExecute: () => setShowReviewSummary((p) => !p) },
      { id: 'toggle-explorer', label: 'Toggle file explorer', shortcut: `${modKey}+B`, section: 'View', onExecute: () => setExplorerVisible((p) => !p) },
    ];

    if (currentSnapshot) {
      cmds.push({ id: 'view-diff', label: 'Toggle diff view', section: 'View', onExecute: () => setViewMode((m) => m === 'diff' ? 'rendered' : 'diff') });
    }

    if (openCommentCount > 0) {
      cmds.push({ id: 'resolve-all', label: 'Resolve all open comments', section: 'Comments', onExecute: handleBulkResolve });
    }

    if (activeCommentId) {
      const activeComment = comments.find((c) => c.id === activeCommentId);
      if (activeComment) {
        const status = getEffectiveStatus(activeComment);
        if (status === 'open') {
          cmds.push({ id: 'resolve-active', label: 'Resolve active comment', shortcut: 'A', section: 'Comments', onExecute: () => handleResolve(activeCommentId) });
        }
        if (status === 'resolved') {
          cmds.push({ id: 'unresolve-active', label: 'Reopen active comment', shortcut: 'U', section: 'Comments', onExecute: () => handleUnresolve(activeCommentId) });
        }
        cmds.push({ id: 'delete-active', label: 'Delete active comment', section: 'Comments', onExecute: () => handleDelete(activeCommentId) });
      }
    }

    return cmds;
  }, [modKey, handleJumpToNext, handleJumpToPrev, reloadFile, handleSnapshot, currentSnapshot, openCommentCount, handleBulkResolve, activeCommentId, comments, handleResolve, handleUnresolve, handleDelete]);

  const fileBrowserContent = (
    <div className="w-full max-w-lg">
      {/* Logo & title */}
      {tabs.length === 0 && (
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-bg-strong mb-4">
            <svg className="w-8 h-8 text-primary-text" viewBox="0 0 32 32" fill="none">
              <rect
                x="4"
                y="2"
                width="18"
                height="24"
                rx="2"
                fill="currentColor"
                opacity="0.15"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <line
                x1="8"
                y1="8"
                x2="18"
                y2="8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <line
                x1="8"
                y1="12"
                x2="16"
                y2="12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <line
                x1="8"
                y1="16"
                x2="18"
                y2="16"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M18 18h8a2 2 0 012 2v6a2 2 0 01-2 2h-4l-3 3v-3h-1a2 2 0 01-2-2v-6a2 2 0 012-2z"
                style={{ fill: 'var(--theme-comment-underline)', stroke: 'var(--theme-comment-underline-active)' }}
                strokeWidth="1"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-content mb-2">md-review</h1>
          <p className="text-content-secondary text-sm leading-relaxed">
            Review and annotate your markdown files with inline comments.
            <br />
            Select text to add comments, just like Google Docs.
          </p>
        </div>
      )}

      {/* File input */}
      <div className="bg-surface-raised rounded-xl shadow-sm border border-border p-6">
        <label className="block text-sm font-medium text-content mb-2">
          Open a markdown file
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleOpenFile(inputPath);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder="/path/to/your/file.md"
            className="flex-1 text-sm border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content"
          />
          <button
            type="submit"
            disabled={!inputPath.trim() || isLoading}
            className="px-4 py-2.5 bg-primary text-on-primary text-sm font-medium rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open
          </button>
        </form>

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}

        {/* Recent files */}
        {recentFiles.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-content-secondary">Recent files</p>
              <button
                onClick={clearRecentFiles}
                className="text-xs text-content-muted hover:text-danger transition-colors"
              >
                Clear
              </button>
            </div>
            <div className="space-y-1">
              {recentFiles.map((file) => (
                <button
                  key={file.path}
                  onClick={() => handleOpenFile(file.path)}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-primary-bg transition-colors group"
                >
                  <span className="font-medium text-content group-hover:text-primary-text">
                    {file.name}
                  </span>
                  <span className="block text-xs text-content-muted truncate">{file.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* File browser */}
        <div className="mt-4 pt-4 border-t border-border-subtle">
          <p className="text-xs font-medium text-content-secondary mb-2">Browse files</p>
          <FileBrowser onOpenFile={handleOpenFile} />
        </div>
      </div>

      {tabs.length === 0 && (
        <p className="text-center text-xs text-content-muted mt-6">
          Comments are stored as HTML comments in your .md file &mdash; no sidecar files needed
        </p>
      )}
    </div>
  );

  // Landing page (no tabs open)
  if (tabs.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gradient-from to-gradient-to flex items-center justify-center p-4">
        {fileBrowserContent}
      </div>
    );
  }

  // Editor view (with tabs)
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
      />
      <TabBar
        tabs={tabs}
        activeFilePath={activeFilePath}
        commentCounts={commentCounts}
        onSwitchTab={(path) => {
          switchTab(path);
          setShowBrowser(false);
          setShowReviewSummary(false);
        }}
        onCloseTab={closeTab}
        onOpenFile={() => setShowBrowser(true)}
        viewMode={viewMode}
        hasSnapshot={currentSnapshot !== null}
        hasExternalChange={hasExternalChange}
        showReviewSummary={showReviewSummary}
        commentCount={openCommentCount}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onSnapshot={handleSnapshot}
        onJumpToNext={handleJumpToNext}
        onToggleReviewSummary={() => setShowReviewSummary((prev) => !prev)}
        onReload={reloadFile}
      />

      {showBrowser ? (
        <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto bg-gradient-to-br from-gradient-from to-gradient-to">
          {fileBrowserContent}
        </div>
      ) : (
        <>
          <div className="flex-1 flex min-h-0 relative">
            {/* File explorer left pane */}
            <div
              className={`border-r border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out ${
                explorerVisible ? 'w-56' : 'w-0 border-r-0'
              }`}
            >
              <div className="w-56 h-full flex flex-col">
                <FileExplorer
                  initialDir={explorerDir}
                  activeFilePath={activeFilePath}
                  onOpenFile={handleExplorerOpenFile}
                  onClose={() => setExplorerVisible(false)}
                />
              </div>
            </div>

            {/* Markdown viewer */}
            <div
              ref={containerRef}
              className="flex-1 overflow-y-auto px-8 py-6 lg:px-12 xl:px-16 relative"
            >
              <div className="max-w-3xl mx-auto">
                {viewMode === 'raw' ? (
                  <pre className="text-sm text-content whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {rawMarkdown}
                  </pre>
                ) : viewMode === 'diff' && currentSnapshot ? (
                  <DiffViewer oldRaw={currentSnapshot} newRaw={rawMarkdown} />
                ) : (
                  <>
                    <MarkdownViewer
                      ref={viewerRef}
                      html={html}
                      comments={comments}
                      activeCommentId={activeCommentId}
                      selectionText={selection?.text ?? null}
                      selectionOffset={selection?.offset ?? null}
                      onHighlightClick={handleHighlightClick}
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

            {/* Comment sidebar */}
            <div
              className={`border-l border-border bg-surface-secondary shrink-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out ${
                sidebarVisible ? 'w-80' : 'w-0 border-l-0'
              }`}
            >
              <div className="w-80 h-full flex flex-col">
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
                    filter={sidebarFilter}
                    onFilterChange={setSidebarFilter}
                    onActivate={handleSidebarActivate}
                    onResolve={handleResolve}
                    onUnresolve={handleUnresolve}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    onReply={handleReply}
                    onBulkResolve={handleBulkResolve}
                    onBulkDeleteResolved={handleBulkDeleteResolved}
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
              onSubmit={(anchor, text, ctxBefore, ctxAfter) => {
                handleAddComment(anchor, text, ctxBefore, ctxAfter);
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
      )}

      {/* Toast notification (Feature 8) */}
      <Toast message={toast.message} visible={toast.visible} onDismiss={dismissToast} />

      {/* Command palette */}
      <CommandPalette
        commands={paletteCommands}
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
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
