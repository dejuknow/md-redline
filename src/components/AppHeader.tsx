import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  INITIAL_HEADER_FIT,
  measureHeader,
  nextHeaderFit,
  rowSlotMinWidth,
} from '../lib/header-fit';
import { isApplePlatform } from '../lib/platform';

export interface AppHeaderProps {
  fileName: string | null;
  folderPath: string | null;
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  /**
   * True when the document area is showing the permission card, which is the
   * usual access-denied case. The header then says nothing: repeating the ask
   * in a row too narrow for an absolute path was the whole problem. It still
   * reports a refusal the card declines to take over, which is a tab that kept
   * its content through a failed reload.
   */
  accessRequestShown: boolean;
  onTrustFolder(): void;
  isLoading: boolean;
  /**
   * The review row, given whether to render it compact. Null when there is no
   * review to show; the file name, folder and Hand off take the row instead.
   */
  renderBanner: ((compact: boolean) => React.ReactNode) | null;
  /** Shown after the review row too, when the active file is in none of the reviews. */
  handOff: React.ReactNode | null;
  focusMode: boolean;
  onExitFocus(): void;
  onOpenPalette(): void;
}

/**
 * The main column's top row. With a review open it is the review's status and
 * actions; otherwise the active file's name and folder, and Hand off. Then a
 * hairline and the command palette chip, and in focus mode the way out.
 *
 * Its left padding reads `--window-inset-left`, which a desktop shell sets to
 * clear its window controls when the sidebar no longer covers them.
 */
export function AppHeader({
  fileName,
  folderPath,
  error,
  errorKind,
  accessRequestShown,
  onTrustFolder,
  isLoading,
  renderBanner,
  handOff,
  focusMode,
  onExitFocus,
  onOpenPalette,
}: AppHeaderProps) {
  const rootRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  // Wide until a measurement says the row does not fit (see header-fit.ts).
  const [fit, setFit] = useState(INITIAL_HEADER_FIT);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const m = measureHeader(root);
    if (!m) {
      if (fitRef.current !== INITIAL_HEADER_FIT) setFit(INITIAL_HEADER_FIT);
      return;
    }
    if (slotRef.current) slotRef.current.style.minWidth = `${rowSlotMinWidth(m)}px`;
    const next = nextHeaderFit(fitRef.current, m);
    if (next !== fitRef.current) {
      fitRef.current = next;
      setFit(next);
    }
  }, []);
  // After every render, before paint, so a fold lands in the same frame.
  useLayoutEffect(measure);
  // And on what changes without a render here: the window's width, and the
  // review row's own state (another review taking it, a label changing).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(root);
    const mutation = new MutationObserver(measure);
    mutation.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [measure]);
  const compact = renderBanner !== null && fit.compact;
  const banner = renderBanner ? renderBanner(compact) : null;
  const isMac = isApplePlatform();
  const paletteKeys = isMac ? '⌘K' : 'Ctrl+K';
  const focusKeys = isMac ? '⌘.' : 'Ctrl+.';

  const showLostAccess = errorKind === 'access-denied' && !accessRequestShown;
  const genericError = errorKind !== 'access-denied' ? error : null;
  // Capped, and truncating at its cap (full text in its title). Beside the
  // file name it keeps from shrinking, so the name gives way. Beside a review
  // row it gives way instead, down to MIN_NOTICE_WIDTH, before the row folds.
  const notices = (showLostAccess || genericError || isLoading) && (
    <div
      data-header-notices
      className={`${banner ? '' : 'shrink-0 '}max-w-[40%] min-w-0 flex items-center gap-2`}
    >
      {genericError && (
        <span className="min-w-0 truncate text-[13px] text-danger font-medium" title={genericError}>
          {genericError}
        </span>
      )}
      {showLostAccess && (
        <span className="min-w-0 flex items-center gap-2 text-[13px] text-content-secondary">
          <span className="min-w-0 truncate" title="Lost access to this file’s folder">
            Lost access to this file&rsquo;s folder
          </span>
          <button
            type="button"
            onClick={onTrustFolder}
            data-testid="toolbar-allow-access"
            className="h-7 shrink-0 px-2 rounded-md text-primary-text hover:bg-tint-primary transition-colors text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Allow&hellip;
          </button>
        </span>
      )}
      {isLoading && <span className="shrink-0 text-[13px] text-content-muted">Loading...</span>}
    </div>
  );

  return (
    <header
      ref={rootRef}
      data-app-header
      className="h-11 shrink-0 min-w-0 flex items-center gap-2 px-1 text-content"
      // Adds to px-1 rather than replacing it.
      style={{ paddingLeft: 'calc(var(--window-inset-left, 0px) + 0.25rem)' }}
    >
      {banner ? (
        <>
          {/* Its min-width is set from measurements (see measure above). */}
          <div ref={slotRef} data-header-banner className="min-w-0 flex-1 flex">
            {banner}
          </div>
          {notices}
          {handOff && (
            <div data-header-actions className="shrink-0 flex items-center gap-2">
              {handOff}
            </div>
          )}
        </>
      ) : (
        <>
          <div data-header-status className="min-w-0 flex items-center gap-2 pl-1.5 text-[13px]">
            {fileName && <span className="min-w-0 truncate font-semibold">{fileName}</span>}
            {folderPath && (
              <span className="min-w-0 truncate text-content-muted" title={folderPath}>
                {folderPath}
              </span>
            )}
          </div>
          {notices}
          <div data-header-actions className="ml-auto shrink-0 flex items-center gap-2">
            {handOff}
          </div>
        </>
      )}

      <div className="w-px h-[18px] shrink-0 bg-border" aria-hidden="true" />
      <button
        type="button"
        // Keeps a painted selection through the click, so the palette can
        // offer to copy it the same as the shortcut does.
        data-preserve-selection
        onClick={onOpenPalette}
        aria-label="Command palette"
        title={`Command palette (${paletteKeys})`}
        className="h-[26px] shrink-0 px-2 border border-border rounded-md bg-surface text-[13px] text-content-muted hover:text-content transition-colors"
      >
        {paletteKeys}
      </button>

      {focusMode && (
        <>
          {/* Gives way to a notice, so the notice and the review row both fit. */}
          {banner && fileName && !notices && (
            <span
              data-focus-file-name
              className="min-w-0 max-w-[30%] truncate text-[13px] text-content-muted"
            >
              {fileName}
            </span>
          )}
          <button
            type="button"
            data-focus-chip
            onClick={onExitFocus}
            aria-label="Exit focus"
            title="Exit focus mode"
            className="h-7 shrink-0 px-2.5 flex items-center gap-2 rounded-md border border-border bg-surface text-[13px] font-medium text-content hover:bg-tint transition-colors"
          >
            Exit focus
            <span className="text-content-muted font-normal" aria-hidden="true">
              {focusKeys}
            </span>
          </button>
        </>
      )}
    </header>
  );
}
