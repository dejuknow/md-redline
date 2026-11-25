import type { RecentFile } from '../hooks/useRecentFiles';
import { getParentDir, tildeShortenPath } from '../lib/path-utils';
import { isApplePlatform } from '../lib/platform';

interface Props {
  recentFiles: RecentFile[];
  homeDir?: string;
  /** True when the left panel is open, so the card can point at the Explorer. */
  explorerShown: boolean;
  onOpenPicker: () => void;
  onOpenRecent: (path: string) => void;
}

const MAX_SHOWN = 5;

const kbdClass =
  'px-1 rounded border border-border-subtle bg-surface font-sans text-[11px] leading-[16px] text-content-muted';

/**
 * What the page shows with no file open: how to open one, plus the last few
 * files so picking up where you left off is one click.
 */
export function NoFileOpen({
  recentFiles,
  homeDir = '',
  explorerShown,
  onOpenPicker,
  onOpenRecent,
}: Props) {
  const openKeys = isApplePlatform() ? '⌘O' : 'Ctrl+O';
  const recent = recentFiles.slice(0, MAX_SHOWN);

  return (
    <div
      data-testid="no-file-open"
      className="absolute inset-0 z-20 overflow-y-auto bg-surface flex justify-center px-6 pt-[14vh] pb-8"
    >
      <div className="w-full max-w-sm flex flex-col items-center text-center">
        <div className="w-11 h-11 rounded-xl bg-surface-inset border border-border-subtle flex items-center justify-center">
          <svg
            className="w-5 h-5 text-content-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M9 13h6M9 17h4" />
          </svg>
        </div>

        <h2 className="mt-4 text-sm font-semibold text-content">No file open</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-content-secondary">
          Open a Markdown file to read and comment on it.
        </p>

        <button
          type="button"
          onClick={onOpenPicker}
          data-testid="no-file-open-button"
          className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-surface text-xs font-medium text-content hover:bg-surface-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Open file…
          <kbd className={kbdClass} aria-hidden="true">
            {openKeys}
          </kbd>
        </button>
        {explorerShown && (
          <p className="mt-2.5 text-[11px] leading-relaxed text-content-muted">
            Or pick one from the Explorer.
          </p>
        )}

        {recent.length > 0 && (
          <div className="mt-8 w-full text-left">
            <div className="px-2 mb-1 text-[11px] font-medium text-content-muted">Recent</div>
            <ul>
              {recent.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onOpenRecent(file.path)}
                    title={file.path}
                    className="w-full min-w-0 flex items-baseline gap-2 px-2 py-1.5 rounded-md text-left hover:bg-surface-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <span className="shrink-0 text-xs text-content">{file.name}</span>
                    <span className="min-w-0 truncate text-[11px] text-content-muted">
                      {tildeShortenPath(getParentDir(file.path), homeDir)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
