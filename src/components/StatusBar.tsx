import { isApplePlatform } from '../lib/platform';

export interface StatusBarProps {
  /** The active file's path, home shortened to `~`. */
  filePath: string | null;
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  /**
   * True when the document area is showing the permission card, which is the
   * usual access-denied case. The bar then says nothing about it. It still
   * reports a refusal the card declines to take over, which is a tab that kept
   * its content through a failed reload.
   */
  accessRequestShown: boolean;
  onTrustFolder(): void;
  isLoading: boolean;
  focusMode: boolean;
  onExitFocus(): void;
  onOpenPalette(): void;
  onOpenShortcuts(): void;
  /** Kept invisible (but laid out) until start-up has laid out the panels, as
   * the main column is, so nothing in it paints ahead of the page. */
  hidden?: boolean;
}

const kbdClass =
  'px-1 rounded border border-border-subtle bg-surface font-sans text-[11px] leading-[16px] text-content-secondary';

const hintButtonClass =
  'h-[22px] shrink-0 px-1.5 flex items-center gap-1.5 rounded-md text-content-muted hover:text-content hover:bg-tint transition-colors';

/**
 * The window's bottom line, on the frame under both panels: the active
 * file's path and any notice on the left, the command palette and shortcut
 * hints on the right, and in focus mode the way out.
 */
export function StatusBar({
  filePath,
  error,
  errorKind,
  accessRequestShown,
  onTrustFolder,
  isLoading,
  focusMode,
  onExitFocus,
  onOpenPalette,
  onOpenShortcuts,
  hidden = false,
}: StatusBarProps) {
  const isMac = isApplePlatform();
  const paletteKeys = isMac ? '⌘K' : 'Ctrl+K';
  const focusKeys = isMac ? '⌘.' : 'Ctrl+.';
  const showLostAccess = errorKind === 'access-denied' && !accessRequestShown;
  const genericError = errorKind !== 'access-denied' ? error : null;

  return (
    <footer
      data-status-bar
      className="h-7 shrink-0 min-w-0 flex items-center gap-3 px-3 text-[12px] text-content-muted"
      style={{ visibility: hidden ? 'hidden' : undefined }}
    >
      {filePath && (
        <span data-status-path className="min-w-0 truncate" title={filePath}>
          {filePath}
        </span>
      )}
      {(showLostAccess || genericError || isLoading) && (
        <div data-status-notices className="min-w-0 max-w-[50%] flex items-center gap-2">
          {genericError && (
            <span className="min-w-0 truncate text-danger font-medium" title={genericError}>
              {genericError}
            </span>
          )}
          {showLostAccess && (
            <span className="min-w-0 flex items-center gap-1.5 text-content-secondary">
              <span className="min-w-0 truncate" title="Lost access to this file’s folder">
                Lost access to this file&rsquo;s folder
              </span>
              <button
                type="button"
                onClick={onTrustFolder}
                data-testid="toolbar-allow-access"
                className="h-[22px] shrink-0 px-1.5 rounded-md text-primary-text font-medium hover:bg-tint-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Allow&hellip;
              </button>
            </span>
          )}
          {isLoading && <span className="shrink-0">Loading...</span>}
        </div>
      )}

      <div className="ml-auto shrink-0 flex items-center gap-1">
        {focusMode && (
          <button
            type="button"
            data-focus-chip
            onClick={onExitFocus}
            aria-label="Exit focus"
            title="Exit focus mode"
            className={`${hintButtonClass} text-content-secondary`}
          >
            Exit focus
            <kbd className={kbdClass} aria-hidden="true">
              {focusKeys}
            </kbd>
          </button>
        )}
        <button
          type="button"
          // Keeps a painted selection through the click, so the palette can
          // offer to copy it the same as the shortcut does.
          data-preserve-selection
          onClick={onOpenPalette}
          aria-label="Command palette"
          title={`Command palette (${paletteKeys})`}
          className={hintButtonClass}
        >
          <kbd className={kbdClass} aria-hidden="true">
            {paletteKeys}
          </kbd>
          Commands
        </button>
        <button
          type="button"
          onClick={onOpenShortcuts}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          className={hintButtonClass}
        >
          <kbd className={kbdClass} aria-hidden="true">
            ?
          </kbd>
          Shortcuts
        </button>
      </div>
    </footer>
  );
}
