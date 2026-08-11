import { FolderIcon } from './icons';
import { getPathBasename, middleTruncatePath, tildeShortenPath } from '../lib/path-utils';

interface Props {
  /**
   * Absolute path of the folder md-redline was refused, or null when the tab's
   * path has no derivable parent (`?file=~`, a Windows drive-relative path).
   * The ask still has to appear in that case; it just cannot name the folder.
   */
  dir: string | null;
  /** User's home directory; used to tilde-shorten the displayed path. */
  homeDir?: string;
  /** True while the native picker is open, so the button can stop inviting clicks. */
  pending?: boolean;
  /**
   * Set after a grant that did not clear this refusal, which in practice means
   * the user picked a folder that does not contain the file. Without it the
   * card reappears word for word and reads as a dead button.
   */
  grantMissed?: boolean;
  onAllow: () => void;
  /**
   * 'page' owns the document area and is the primary ask. 'panel' is the
   * explorer's version: the same words, deliberately quieter, so two surfaces
   * refusing the same folder read as one request with a footnote rather than
   * two competing calls to action.
   */
  variant?: 'page' | 'panel';
}

const PENDING_LABEL = 'Waiting for the system dialog…';
const ALLOW_LABEL = 'Allow this folder…';
const MISSED_NOTE = 'That folder does not cover this file. Try one further up.';

export function AccessRequest({
  dir,
  homeDir = '',
  pending,
  grantMissed,
  onAllow,
  variant = 'page',
}: Props) {
  const displayPath = dir ? tildeShortenPath(dir, homeDir) : '';
  const folderName = dir ? getPathBasename(dir) || displayPath : 'This folder';

  if (variant === 'panel') {
    return (
      <div
        data-testid="access-request-panel"
        role="status"
        className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <FolderIcon className="w-6 h-6 text-content-faint" />
        <div className="min-w-0 w-full">
          <div className="text-xs font-medium text-content">Folder not allowed</div>
          {dir && (
            // The budget is set for the panel's default width, where the
            // elision is what the user reads; `truncate` is the overflow guard
            // for a panel dragged to its 160px minimum. Budgeting for the
            // minimum instead threw away the head at every normal width.
            <div className="mt-0.5 text-[11px] text-content-muted truncate" title={dir}>
              {middleTruncatePath(displayPath, 26)}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onAllow}
          disabled={pending}
          data-testid="access-request-panel-allow"
          className="text-[11px] font-medium text-primary-text px-2 py-1 rounded hover:bg-tint-primary transition-colors disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {pending ? PENDING_LABEL : ALLOW_LABEL}
        </button>
      </div>
    );
  }

  return (
    // role=status + aria-live: this replaced the toolbar strip that used to
    // announce the refusal, and swapping the document region for a card is
    // silent to a screen reader on its own.
    <div
      data-testid="access-request"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 overflow-y-auto bg-surface-secondary flex justify-center px-6 pt-[14vh] pb-8"
    >
      <div className="w-full max-w-xs flex flex-col items-center text-center">
        <div className="w-11 h-11 rounded-xl bg-surface-inset border border-border-subtle flex items-center justify-center">
          <FolderIcon className="w-5 h-5 text-content-muted" />
        </div>

        <h2 className="mt-4 text-sm font-semibold text-content">
          md-redline can&rsquo;t read this folder
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-content-secondary">
          It only opens files in folders you have allowed. Allowing this one is remembered for next
          time.
        </p>

        {dir && (
          <div className="mt-4 w-full rounded-lg border border-border-subtle bg-surface-inset px-3 py-2.5 text-left">
            <div className="text-xs font-medium text-content truncate" title={folderName}>
              {folderName}
            </div>
            <div className="mt-0.5 text-[11px] text-content-muted truncate" title={dir}>
              {middleTruncatePath(displayPath)}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onAllow}
          disabled={pending}
          data-testid="access-request-allow"
          className="mt-4 px-3.5 py-1.5 rounded-md bg-primary text-on-primary text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {pending ? PENDING_LABEL : ALLOW_LABEL}
        </button>

        <p className="mt-2.5 text-[11px] leading-relaxed text-content-muted">
          {grantMissed
            ? MISSED_NOTE
            : 'Opens a system dialog. Choose a parent folder to allow everything inside it.'}
        </p>
      </div>
    </div>
  );
}
