import { useState, useRef, useEffect } from 'react';
import { getAuthorColor } from '../hooks/useAuthor';

export type ViewMode = 'rendered' | 'raw' | 'diff';

interface Props {
  lastSaved: Date | null;
  error: string | null;
  isLoading: boolean;
  showExplorer: boolean;
  sidebarVisible: boolean;
  author: string;
  onAuthorChange: (name: string) => void;
  onToggleExplorer: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onSearch: () => void;
  searchActive: boolean;
}

export function Toolbar({
  lastSaved,
  error,
  isLoading,
  showExplorer,
  sidebarVisible,
  author,
  onAuthorChange,
  onToggleExplorer,
  onToggleSidebar,
  onOpenSettings,
  onSearch,
  searchActive,
}: Props) {
  const [editingAuthor, setEditingAuthor] = useState(false);
  const [authorDraft, setAuthorDraft] = useState(author);
  const authorInputRef = useRef<HTMLInputElement>(null);
  const authorColor = getAuthorColor(author);

  useEffect(() => {
    if (editingAuthor && authorInputRef.current) {
      authorInputRef.current.focus();
      authorInputRef.current.select();
    }
  }, [editingAuthor]);

  const commitAuthor = () => {
    onAuthorChange(authorDraft);
    setEditingAuthor(false);
  };

  return (
    <div className="h-12 border-b border-border bg-surface flex items-center px-4 gap-3 shrink-0">
      {/* Explorer toggle (far left) */}
      <button
        onClick={onToggleExplorer}
        className={`p-1 rounded transition-colors ${
          showExplorer
            ? 'text-primary-text bg-primary-bg'
            : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
        }`}
        title="Toggle file explorer (Cmd+B)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
          />
        </svg>
      </button>

      {/* Separator */}
      <div className="h-5 w-px bg-border" />

      {/* App logo + name */}
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-primary-text" viewBox="0 0 32 32" fill="none">
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
          <line x1="8" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="16" x2="18" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M18 18h8a2 2 0 012 2v6a2 2 0 01-2 2h-4l-3 3v-3h-1a2 2 0 01-2-2v-6a2 2 0 012-2z"
            style={{ fill: 'var(--theme-comment-underline)', stroke: 'var(--theme-comment-underline-active)' }}
            strokeWidth="1"
          />
        </svg>
        <span className="text-sm font-semibold text-content">md-review</span>
      </div>

      {/* Center spacer with status */}
      <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
        {error && <span className="text-xs text-danger font-medium">{error}</span>}
        {isLoading && <span className="text-xs text-content-muted">Loading...</span>}
        {lastSaved && !error && !isLoading && (
          <span className="text-xs text-content-muted">Saved {lastSaved.toLocaleTimeString()}</span>
        )}
      </div>

      {/* Author name */}
      {editingAuthor ? (
        <input
          ref={authorInputRef}
          value={authorDraft}
          onChange={(e) => setAuthorDraft(e.target.value)}
          onBlur={commitAuthor}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAuthor();
            if (e.key === 'Escape') {
              setAuthorDraft(author);
              setEditingAuthor(false);
            }
          }}
          className="text-xs w-24 px-1.5 py-0.5 rounded border border-primary bg-surface text-content focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Your name"
        />
      ) : (
        <button
          onClick={() => {
            setAuthorDraft(author);
            setEditingAuthor(true);
          }}
          className="flex items-center gap-1.5 text-xs text-content-secondary hover:text-content transition-colors px-1.5 py-0.5 rounded hover:bg-surface-inset"
          title="Click to change author name"
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: authorColor.text }}
          />
          {author}
        </button>
      )}

      {/* Search */}
      <button
        onClick={onSearch}
        className={`p-1 rounded transition-colors ${
          searchActive
            ? 'text-primary-text bg-primary-bg'
            : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
        }`}
        title="Find in document (Cmd+F)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path strokeLinecap="round" d="m21 21-4.35-4.35" />
        </svg>
      </button>

      {/* Settings */}
      <button
        onClick={onOpenSettings}
        className="text-content-muted hover:text-content-secondary transition-colors p-1 rounded hover:bg-surface-inset"
        title="Settings (Cmd+,)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* Separator */}
      <div className="h-5 w-px bg-border" />

      {/* Comments sidebar toggle (far right, mirrors explorer) */}
      <button
        onClick={onToggleSidebar}
        className={`p-1 rounded transition-colors ${
          sidebarVisible
            ? 'text-primary-text bg-primary-bg'
            : 'text-content-muted hover:text-content-secondary hover:bg-surface-inset'
        }`}
        title="Toggle comments sidebar (Cmd+\)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
      </button>
    </div>
  );
}
