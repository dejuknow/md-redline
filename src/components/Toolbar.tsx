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
}

export function Toolbar({ error, errorKind, accessRequestShown, onTrustFolder, isLoading }: Props) {
  return (
    <div className="h-11 border-b border-border bg-surface-secondary flex items-center px-4 gap-3 shrink-0">
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
    </div>
  );
}
