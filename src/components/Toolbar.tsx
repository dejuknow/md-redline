import { useState, useRef, useEffect } from 'react';
import { getPrimaryModifierLabel } from '../lib/platform';
import { IconButton } from './IconButton';

export type ViewMode = 'rendered' | 'raw';

interface Props {
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  /**
   * True when the document area is showing the permission card, which is the
   * usual access-denied case. The toolbar then says nothing: repeating the ask
   * in a strip too narrow for an absolute path was the whole problem. It still
   * reports a refusal the card declines to take over, which is a tab that kept
   * its content through a failed reload.
   */
  accessRequestShown: boolean;
  onTrustFolder: () => void;
  isLoading: boolean;
  /** Whether a comments surface is actually on screen (rail or drawer), which
   * is what the toggle button's active state reflects. Not the same as the
   * sidebarVisible intent flag: at a width too narrow for the rail the toggle
   * drives the drawer instead, so the button must track the drawer too. */
  commentsSurfaceVisible: boolean;
  author: string;
  onAuthorChange: (name: string) => void;
  onToggleSidebar: () => void;
  tabs?: React.ReactNode;
}

export function Toolbar({
  error,
  errorKind,
  accessRequestShown,
  onTrustFolder,
  isLoading,
  commentsSurfaceVisible,
  author,
  onAuthorChange,
  onToggleSidebar,
  tabs,
}: Props) {
  const [editingAuthor, setEditingAuthor] = useState(false);
  const [authorDraft, setAuthorDraft] = useState(author);
  const authorInputRef = useRef<HTMLInputElement>(null);
  const modLabel = getPrimaryModifierLabel();

  // Sync draft when author changes externally (e.g. from Settings panel)
  useEffect(() => {
    if (!editingAuthor) setAuthorDraft(author);
  }, [author, editingAuthor]);

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
    <div className="h-11 border-b border-border bg-surface-secondary flex items-center px-4 gap-3 shrink-0">
      {/* pt keeps tab tops off the viewport edge; tabs stay bottom-aligned
          so the active tab still merges into the sheet below. */}
      {tabs && <div className="flex-1 min-w-0 self-stretch flex items-end pt-1.5">{tabs}</div>}

      {/* Center spacer with status. */}
      <div className="flex items-center gap-2 min-w-0 shrink">
        {error && errorKind !== 'access-denied' && (
          <span className="text-xs text-danger font-medium truncate">{error}</span>
        )}
        {errorKind === 'access-denied' && !accessRequestShown && (
          <span className="text-xs text-content-secondary flex items-center gap-2 min-w-0">
            <span className="truncate">Lost access to this file&rsquo;s folder</span>
            <button
              type="button"
              onClick={onTrustFolder}
              data-testid="toolbar-allow-access"
              className="shrink-0 px-2 py-0.5 rounded text-primary-text hover:bg-tint-primary transition-colors text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Allow&hellip;
            </button>
          </span>
        )}
        {isLoading && <span className="text-xs text-content-muted">Loading...</span>}
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
          className="flex items-center gap-1.5 text-xs text-content-secondary hover:text-content transition-colors px-1.5 py-0.5 rounded hover:bg-tint"
          title="Click to change author name"
        >
          {author}
        </button>
      )}

      {/* Comments rail toggle (far right; settings lives at the sidebar's bottom) */}
      <IconButton
        variant="active"
        active={commentsSurfaceVisible}
        size="md"
        onClick={onToggleSidebar}
        title={`Toggle comments rail (${modLabel}+\\)`}
      >
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
      </IconButton>
    </div>
  );
}
