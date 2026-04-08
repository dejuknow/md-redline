import { useState, useRef, useEffect } from 'react';
import { getPrimaryModifierLabel } from '../lib/platform';
import { tildeShortenPath } from '../lib/path-utils';
import { IconButton } from './IconButton';
import { Separator } from './Separator';

export type ViewMode = 'rendered' | 'raw';

interface Props {
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  /** When errorKind is 'access-denied', the directory the trust click would grant. */
  accessDeniedDir: string | null;
  /** User's home directory; used to tilde-shorten the path in the trust prompt. */
  homeDir: string;
  isLoading: boolean;
  showExplorer: boolean;
  sidebarVisible: boolean;
  author: string;
  onAuthorChange: (name: string) => void;
  onToggleExplorer: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onTrustFolder: () => void;
}

export function Toolbar({
  error,
  errorKind,
  accessDeniedDir,
  homeDir,
  isLoading,
  showExplorer,
  sidebarVisible,
  author,
  onAuthorChange,
  onToggleExplorer,
  onToggleSidebar,
  onOpenSettings,
  onTrustFolder,
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
    <div className="h-12 border-b border-border bg-surface flex items-center px-4 gap-3 shrink-0">
      {/* Explorer toggle (far left) */}
      <IconButton
        variant="active"
        active={showExplorer}
        size="md"
        onClick={onToggleExplorer}
        title={`Toggle file explorer (${modLabel}+B)`}
      >
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
          />
        </svg>
      </IconButton>

      <Separator />

      {/* App logo + name — keep in sync with public/favicon.svg */}
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5" viewBox="0 0 100 116" style={{ fillRule: 'evenodd', clipRule: 'evenodd', strokeLinejoin: 'round', strokeMiterlimit: 2 }}>
          <g transform="matrix(1,0,0,1,-10,-2)">
            <path d="M100,18L100,102C100,107.519 95.519,112 90,112L30,112C24.481,112 20,107.519 20,102L20,18C20,12.481 24.481,8 30,8L90,8C95.519,8 100,12.481 100,18Z" style={{ fill: 'white', stroke: 'currentColor', strokeWidth: 4, opacity: 0.8 }} />
          </g>
          <g transform="matrix(0.935484,0,0,1.6,-6.129032,-30.8)">
            <path d="M91,36.125L91,39.875C91,41.6 88.605,43 85.655,43L34.345,43C31.395,43 29,41.6 29,39.875L29,36.125C29,34.4 31.395,33 34.345,33L85.655,33C88.605,33 91,34.4 91,36.125Z" style={{ fill: 'rgb(55,55,55)' }} />
          </g>
          <g transform="matrix(0.935484,0,0,1.6,-6.129032,-34.8)">
            <path d="M91,56.125L91,59.875C91,61.6 88.605,63 85.655,63L34.345,63C31.395,63 29,61.6 29,59.875L29,56.125C29,54.4 31.395,53 34.345,53L85.655,53C88.605,53 91,54.4 91,56.125Z" style={{ fill: 'rgb(220,38,38)' }} />
          </g>
          <g transform="matrix(0.916667,0,0,1.6,-5.583333,-38.8)">
            <path d="M77,76.125L77,79.875C77,81.6 74.556,83 71.545,83L34.455,83C31.444,83 29,81.6 29,79.875L29,76.125C29,74.4 31.444,73 34.455,73L71.545,73C74.556,73 77,74.4 77,76.125Z" style={{ fill: 'rgb(55,55,55)' }} />
          </g>
        </svg>
        <span className="text-sm font-semibold text-content">md-redline</span>
      </div>

      {/* Center spacer with status */}
      <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
        {error && (
          <span className="text-xs text-danger font-medium flex items-center gap-2 min-w-0">
            <span className="truncate" title={accessDeniedDir ?? undefined}>
              {errorKind === 'access-denied'
                ? accessDeniedDir
                  ? `Allow md-redline to read ${tildeShortenPath(accessDeniedDir, homeDir)}?`
                  : 'Allow md-redline to read this folder?'
                : error}
            </span>
            {errorKind === 'access-denied' && (
              <button
                type="button"
                onClick={() => onTrustFolder()}
                className="shrink-0 px-2 py-0.5 rounded border border-danger/50 text-danger hover:bg-danger/10 transition-colors text-[11px] font-medium"
              >
                Allow access
              </button>
            )}
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

      {/* Settings */}
      <IconButton size="md" onClick={onOpenSettings} title={`Settings (${modLabel}+,)`}>
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </IconButton>

      <Separator />

      {/* Comments sidebar toggle (far right, mirrors explorer) */}
      <IconButton
        variant="active"
        active={sidebarVisible}
        size="md"
        onClick={onToggleSidebar}
        title={`Toggle comments sidebar (${modLabel}+\\)`}
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
