import { useEffect, useState } from 'react';

/** A file usually loads in a few milliseconds; "Loading..." shown for that
 * long reads as a flicker, so it waits this long first. */
export const PAGE_LOADING_DELAY_MS = 300;

export interface PageNoticeProps {
  error: string | null;
  errorKind: 'access-denied' | 'generic' | null;
  /**
   * True when the document area is showing the permission card, which is the
   * usual access-denied case. The notice then says nothing about it. It still
   * reports a refusal the card declines to take over, which is a tab that kept
   * its content through a failed reload.
   */
  accessRequestShown: boolean;
  onTrustFolder(): void;
  isLoading: boolean;
}

/**
 * A thin line at the top of the page card for what the page cannot say for
 * itself: a load error, lost access to a file still on screen (with its Allow
 * button), or a slow first load. It shows nothing when there is nothing to say.
 */
export function PageNotice({
  error,
  errorKind,
  accessRequestShown,
  onTrustFolder,
  isLoading,
}: PageNoticeProps) {
  const [loadingIsSlow, setLoadingIsSlow] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setLoadingIsSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setLoadingIsSlow(true), PAGE_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isLoading]);

  const showLostAccess = errorKind === 'access-denied' && !accessRequestShown;
  const genericError = errorKind !== 'access-denied' ? error : null;
  const showLoading = isLoading && loadingIsSlow;
  const hasNotice = showLostAccess || !!genericError || showLoading;

  // The live region stays mounted, empty, so a notice appearing in it is
  // announced; one mounted with its text already inside often is not.
  return (
    <div role="status" className="contents">
      {hasNotice && (
        <div
          data-page-notices
          className="h-8 shrink-0 min-w-0 flex items-center gap-3 px-3 border-b border-border-subtle bg-surface-secondary text-[12px] text-content-muted"
        >
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
          {showLoading && <span className="shrink-0">Loading...</span>}
        </div>
      )}
    </div>
  );
}
