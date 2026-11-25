import type { RecentFile } from '../hooks/useRecentFiles';
import { getParentDir, middleTruncatePath, tildeShortenPath } from '../lib/path-utils';
import { isApplePlatform } from '../lib/platform';
import { AppLogo } from './AppLogo';

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
      className="absolute inset-0 z-20 overflow-y-auto bg-surface flex justify-center px-6 pt-[16vh] pb-8"
    >
      <div className="w-full max-w-md flex flex-col items-center">
        <AppLogo className="w-14 h-16 text-content-muted" />

        <h2 className="mt-5 text-[15px] font-semibold text-content">No file open</h2>

        <button
          type="button"
          onClick={onOpenPicker}
          data-testid="no-file-open-button"
          title={explorerShown ? 'Or pick one from the Explorer' : undefined}
          className="mt-4 inline-flex items-center gap-2.5 pl-3.5 pr-2 py-1.5 rounded-lg border border-border bg-surface text-[13px] font-medium text-content shadow-sm hover:bg-surface-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Open file…
          <kbd className={kbdClass} aria-hidden="true">
            {openKeys}
          </kbd>
        </button>

        {recent.length > 0 && (
          <div className="mt-12 w-full">
            <div className="px-1 mb-2 text-[11px] font-medium uppercase tracking-wide text-content-muted">
              Recent
            </div>
            <ul className="rounded-lg border border-border-subtle divide-y divide-border-subtle overflow-hidden">
              {recent.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onOpenRecent(file.path)}
                    title={file.path}
                    className="w-full min-w-0 flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-inset transition-colors focus-visible:outline-none focus-visible:bg-surface-inset"
                  >
                    <FileGlyph />
                    <span className="min-w-0 truncate text-[13px] text-content">{file.name}</span>
                    <span className="ml-auto pl-3 shrink-0 text-[11px] text-content-muted">
                      {middleTruncatePath(tildeShortenPath(getParentDir(file.path), homeDir), 28)}
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

function FileGlyph() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0 text-content-faint"
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
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5" />
    </svg>
  );
}
