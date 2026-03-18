import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useTabs } from './hooks/useTabs';
import { useSelection } from './hooks/useSelection';
import { useRecentFiles } from './hooks/useRecentFiles';
import { parseComments, insertComment, removeComment, resolveComment, unresolveComment } from './lib/comment-parser';
import { renderMarkdown } from './markdown/pipeline';
import { MarkdownViewer, type MarkdownViewerHandle } from './components/MarkdownViewer';
import { CommentSidebar } from './components/CommentSidebar';
import { CommentForm } from './components/CommentForm';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { FileBrowser } from './components/FileBrowser';

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
  const [viewMode, setViewMode] = useState<ViewMode>('rendered');

  const viewerRef = useRef<MarkdownViewerHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { selection, clearSelection, lockSelection } = useSelection(containerRef);

  // Parse comments from raw markdown
  const { cleanMarkdown, comments } = useMemo(
    () => parseComments(rawMarkdown),
    [rawMarkdown]
  );

  // Render markdown to HTML
  const html = useMemo(
    () => (cleanMarkdown ? renderMarkdown(cleanMarkdown) : ''),
    [cleanMarkdown]
  );

  // Clear transient state on tab switch
  useEffect(() => {
    setActiveCommentId(null);
    clearSelection();
  }, [activeFilePath, clearSelection]);

  // Load initial file from CLI arg
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        if (data.initialFile) {
          setInputPath(data.initialFile);
          openTab(data.initialFile);
        }
      })
      .catch(() => {});
  }, [openTab]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (path.trim()) {
        setInputPath(path);
        openTab(path.trim());
        addRecentFile(path.trim());
        setShowBrowser(false);
      }
    },
    [openTab, addRecentFile]
  );

  const updateAndSave = useCallback(
    (newRaw: string) => {
      setRawMarkdown(newRaw);
      saveFile(newRaw);
    },
    [setRawMarkdown, saveFile]
  );

  const handleAddComment = useCallback(
    (anchor: string, text: string) => {
      const newRaw = insertComment(rawMarkdown, anchor, text);
      updateAndSave(newRaw);
      clearSelection();
    },
    [rawMarkdown, updateAndSave, clearSelection]
  );

  const handleResolve = useCallback(
    (id: string) => {
      updateAndSave(resolveComment(rawMarkdown, id));
    },
    [rawMarkdown, updateAndSave]
  );

  const handleUnresolve = useCallback(
    (id: string) => {
      updateAndSave(unresolveComment(rawMarkdown, id));
    },
    [rawMarkdown, updateAndSave]
  );

  const handleDelete = useCallback(
    (id: string) => {
      updateAndSave(removeComment(rawMarkdown, id));
      if (activeCommentId === id) setActiveCommentId(null);
    },
    [rawMarkdown, updateAndSave, activeCommentId]
  );

  const handleHighlightClick = useCallback(
    (commentId: string) => {
      setActiveCommentId(commentId);
    },
    []
  );

  const handleSidebarActivate = useCallback(
    (commentId: string) => {
      setActiveCommentId(commentId);
      viewerRef.current?.scrollToComment(commentId);
    },
    []
  );

  const fileBrowserContent = (
    <div className="w-full max-w-lg">
      {/* Logo & title */}
      {tabs.length === 0 && (
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-100 mb-4">
            <svg className="w-8 h-8 text-indigo-600" viewBox="0 0 32 32" fill="none">
              <rect x="4" y="2" width="18" height="24" rx="2" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8" y1="16" x2="18" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M18 18h8a2 2 0 012 2v6a2 2 0 01-2 2h-4l-3 3v-3h-1a2 2 0 01-2-2v-6a2 2 0 012-2z" fill="#f59e0b" stroke="#d97706" strokeWidth="1" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">
            md-commenter
          </h1>
          <p className="text-slate-500 text-sm leading-relaxed">
            Review and annotate your markdown files with inline comments.
            <br />
            Select text to add comments, just like Google Docs.
          </p>
        </div>
      )}

      {/* File input */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <label className="block text-sm font-medium text-slate-700 mb-2">
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
            className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={!inputPath.trim() || isLoading}
            className="px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open
          </button>
        </form>

        {error && (
          <p className="mt-2 text-sm text-red-500">{error}</p>
        )}

        {/* Recent files */}
        {recentFiles.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-slate-500">
                Recent files
              </p>
              <button
                onClick={clearRecentFiles}
                className="text-xs text-slate-400 hover:text-red-500 transition-colors"
              >
                Clear
              </button>
            </div>
            <div className="space-y-1">
              {recentFiles.map((file) => (
                <button
                  key={file.path}
                  onClick={() => handleOpenFile(file.path)}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-indigo-50 transition-colors group"
                >
                  <span className="font-medium text-slate-700 group-hover:text-indigo-600">
                    {file.name}
                  </span>
                  <span className="block text-xs text-slate-400 truncate">
                    {file.path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* File browser */}
        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-2">
            Browse files
          </p>
          <FileBrowser onOpenFile={handleOpenFile} />
        </div>
      </div>

      {tabs.length === 0 && (
        <p className="text-center text-xs text-slate-400 mt-6">
          Comments are stored as HTML comments in your .md file &mdash; no sidecar files needed
        </p>
      )}
    </div>
  );

  // Landing page (no tabs open)
  if (tabs.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50/30 flex items-center justify-center p-4">
        {fileBrowserContent}
      </div>
    );
  }

  // Editor view (with tabs)
  return (
    <div className="h-screen flex flex-col bg-white">
      <Toolbar
        filePath={filePath}
        lastSaved={lastSaved}
        error={error}
        isLoading={isLoading}
        commentCount={comments.filter((c) => !c.resolved).length}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          if (mode === 'raw') clearSelection();
        }}
        onReload={reloadFile}
      />
      <TabBar
        tabs={tabs}
        activeFilePath={activeFilePath}
        onSwitchTab={(path) => { switchTab(path); setShowBrowser(false); }}
        onCloseTab={closeTab}
        onOpenFile={() => setShowBrowser(true)}
      />

      {showBrowser ? (
        <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto bg-gradient-to-br from-slate-50 to-indigo-50/30">
          {fileBrowserContent}
        </div>
      ) : (
        <>
          <div className="flex-1 flex min-h-0">
            {/* Markdown viewer */}
            <div ref={containerRef} className="flex-1 overflow-y-auto px-8 py-6 lg:px-12 xl:px-16">
              <div className="max-w-3xl mx-auto">
                {viewMode === 'raw' ? (
                  <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words font-mono leading-relaxed">{rawMarkdown}</pre>
                ) : (
                  <MarkdownViewer
                    ref={viewerRef}
                    html={html}
                    comments={comments}
                    activeCommentId={activeCommentId}
                    selectionText={selection?.text ?? null}
                    onHighlightClick={handleHighlightClick}
                  />
                )}
              </div>
            </div>

            {/* Comment sidebar */}
            <div className="w-80 border-l border-slate-200 bg-slate-50/30 shrink-0 flex flex-col">
              <div className="h-10 border-b border-slate-200 flex items-center px-4">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Comments
                </h2>
              </div>
              <div className="flex-1 min-h-0">
                <CommentSidebar
                  comments={comments}
                  activeCommentId={activeCommentId}
                  onActivate={handleSidebarActivate}
                  onResolve={handleResolve}
                  onUnresolve={handleUnresolve}
                  onDelete={handleDelete}
                />
              </div>
            </div>
          </div>

          {/* Floating comment form (disabled in raw view) */}
          {selection && viewMode === 'rendered' && (
            <CommentForm
              selection={selection}
              onSubmit={handleAddComment}
              onCancel={clearSelection}
              onLock={lockSelection}
            />
          )}
        </>
      )}
    </div>
  );
}
