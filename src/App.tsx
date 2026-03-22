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
  setCommentStatus,
  addReply,
  resolveAllComments,
  removeResolvedComments,
} from './lib/comment-parser';
import { renderMarkdown } from './markdown/pipeline';
import { MarkdownViewer, type MarkdownViewerHandle } from './components/MarkdownViewer';
import { CommentSidebar } from './components/CommentSidebar';
import { CommentForm, TEMPLATES } from './components/CommentForm';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { FileBrowser } from './components/FileBrowser';
import { DragHandles } from './components/DragHandles';
import { DiffViewer } from './components/DiffViewer';
import { Toast } from './components/Toast';
import { ReviewSummary } from './components/ReviewSummary';
import { useDragHandles } from './hooks/useDragHandles';
import type { CommentStatus } from './types';
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
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();

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
  const missingAnchors = useMemo(() => {
    const missing = new Set<string>();
    if (!cleanMarkdown) return missing;
    for (const c of comments) {
      if (getEffectiveStatus(c) === 'accepted') continue;
      // Check if the anchor text exists in the clean markdown
      if (!cleanMarkdown.includes(c.anchor)) {
        // Try flexible match (whitespace-normalized)
        const parts = c.anchor.split(/\s+/).filter(Boolean);
        if (parts.length === 0) continue;
        const allFound = parts.every((p) => cleanMarkdown.includes(p));
        if (!allFound) {
          missing.add(c.id);
        }
      }
    }
    return missing;
  }, [cleanMarkdown, comments]);

  // Comment counts per tab (for badges)
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.filePath === activeFilePath) {
        counts.set(
          tab.filePath,
          comments.filter((c) => getEffectiveStatus(c) !== 'accepted').length,
        );
      } else {
        try {
          const { comments: tabComments } = parseComments(tab.rawMarkdown);
          counts.set(
            tab.filePath,
            tabComments.filter((c) => getEffectiveStatus(c) !== 'accepted').length,
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

          let addressedCount = 0;
          let newReplyCount = 0;
          for (const oldC of oldComments) {
            const oldStatus = getEffectiveStatus(oldC);
            const newC = newById.get(oldC.id);
            if (!newC) continue;
            const newStatus = getEffectiveStatus(newC);
            if (
              (oldStatus === 'open' || oldStatus === 'reopened') &&
              newStatus === 'addressed'
            ) {
              addressedCount++;
            }
            const oldReplies = oldC.replies?.length ?? 0;
            const newReplies = newC.replies?.length ?? 0;
            if (newReplies > oldReplies) {
              newReplyCount += newReplies - oldReplies;
            }
          }

          if (addressedCount > 0) {
            showToast(
              `Agent addressed ${addressedCount} comment${addressedCount > 1 ? 's' : ''}`,
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

  // Load initial file from URL ?file= param, CLI arg, or restored session
  useEffect(() => {
    const urlFile = new URLSearchParams(window.location.search).get('file');
    if (urlFile) {
      setInputPath(urlFile);
      openTab(urlFile);
      addRecentFile(urlFile);
      // Clean the URL so refreshing doesn't re-trigger
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
        'User',
        contextBefore,
        contextAfter,
      );
      updateAndSave(newRaw);
      clearSelection();
      setAutoExpandForm(false);
    },
    [updateAndSave, clearSelection],
  );

  const handleSetStatus = useCallback(
    (id: string, status: CommentStatus) => {
      updateAndSave(setCommentStatus(rawMarkdownRef.current, id, status));
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
      updateAndSave(addReply(rawMarkdownRef.current, id, text));
    },
    [updateAndSave],
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

  // Jump to next unresolved comment
  const handleJumpToNext = useCallback(() => {
    const unresolvedComments = comments.filter((c) => {
      const s = getEffectiveStatus(c);
      return s === 'open' || s === 'reopened' || s === 'addressed';
    });
    if (unresolvedComments.length === 0) return;

    const currentIdx = activeCommentId
      ? unresolvedComments.findIndex((c) => c.id === activeCommentId)
      : -1;
    const nextIdx = (currentIdx + 1) % unresolvedComments.length;
    const next = unresolvedComments[nextIdx];
    setActiveCommentId(next.id);
    viewerRef.current?.scrollToComment(next.id);
  }, [comments, activeCommentId]);

  // Jump to previous unresolved comment
  const handleJumpToPrev = useCallback(() => {
    const unresolvedComments = comments.filter((c) => {
      const s = getEffectiveStatus(c);
      return s === 'open' || s === 'reopened' || s === 'addressed';
    });
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

  const openCommentCount = comments.filter((c) => getEffectiveStatus(c) !== 'accepted').length;

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
        // The selection hook handles detection — we just need the form to appear.
        // If there's already a selection, lock it and the form will show.
        if (selectionRef.current) {
          lockSelection();
        }
        return;
      }

      // N / P : Jump to next / previous comment (only when not in an input)
      if (!isInput && !mod && !e.shiftKey && !e.altKey) {
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          handleJumpToNext();
          return;
        }
        if (e.key.toLowerCase() === 'p') {
          e.preventDefault();
          handleJumpToPrev();
          return;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lockSelection, handleJumpToNext, handleJumpToPrev, handleAddComment, viewMode]);

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const modKey = isMac ? '\u2318' : 'Ctrl';

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
          <h1 className="text-2xl font-bold text-content mb-2">md-commenter</h1>
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
        filePath={filePath}
        lastSaved={lastSaved}
        error={error}
        isLoading={isLoading}
        commentCount={openCommentCount}
        viewMode={viewMode}
        hasSnapshot={currentSnapshot !== null}
        hasExternalChange={hasExternalChange}
        showReviewSummary={showReviewSummary}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onReload={reloadFile}
        onSnapshot={handleSnapshot}
        onJumpToNext={handleJumpToNext}
        onToggleReviewSummary={() => setShowReviewSummary((prev) => !prev)}
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
      />

      {showBrowser ? (
        <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto bg-gradient-to-br from-gradient-from to-gradient-to">
          {fileBrowserContent}
        </div>
      ) : (
        <>
          <div className="flex-1 flex min-h-0 relative">
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
            {sidebarVisible && (
              <div className="w-80 border-l border-border bg-surface-secondary shrink-0 flex flex-col">
                <div className="h-10 border-b border-border flex items-center px-4">
                  <h2 className="text-xs font-semibold text-content-secondary uppercase tracking-wider">
                    Comments
                  </h2>
                </div>
                <div className="flex-1 min-h-0">
                  <CommentSidebar
                    comments={comments}
                    activeCommentId={activeCommentId}
                    missingAnchors={missingAnchors}
                    filter={sidebarFilter}
                    onFilterChange={setSidebarFilter}
                    onActivate={handleSidebarActivate}
                    onSetStatus={handleSetStatus}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    onReply={handleReply}
                    onBulkResolve={handleBulkResolve}
                    onBulkDeleteResolved={handleBulkDeleteResolved}
                  />
                </div>
              </div>
            )}

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

      {/* Keyboard shortcuts hint */}
      <div className="h-6 bg-surface-secondary border-t border-border flex items-center px-4 gap-4 text-[10px] text-content-muted shrink-0">
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
            {modKey}+\
          </kbd>{' '}
          Sidebar
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+Enter
          </kbd>{' '}
          Comment
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-surface rounded border border-border text-content-secondary font-mono">
            {modKey}+1-8
          </kbd>{' '}
          Quick template
        </span>
      </div>
    </div>
  );
}
