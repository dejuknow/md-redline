import type { ShowToast } from '../hooks/useToast';
import { TOAST_BG, TOAST_FG } from './Toast';

export const UPGRADE_COMMAND = 'npm install -g md-redline@latest';

interface Props {
  latest: string | null;
  onDismiss: () => void;
  showToast: ShowToast;
}

/**
 * Quiet update-available pill. Same inverted-surface treatment and corner as
 * the toast bar, stacked above the toast slot, but persistent: unlike a
 * toast it stays until dismissed. Deliberately neutral styling; an update is
 * information, not an alert.
 */
export function UpdateNotice({ latest, onDismiss, showToast }: Props) {
  if (!latest) return null;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(UPGRADE_COMMAND);
      showToast('Copied', 'success');
    } catch {
      showToast(`Copy failed. Run: ${UPGRADE_COMMAND}`, 'error');
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-update-notice
      className="fixed bottom-24 right-4 z-50"
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium"
        style={{ background: TOAST_BG, color: TOAST_FG }}
      >
        <span>mdr {latest} is available</span>
        <code className="px-2 py-0.5 rounded text-xs bg-current/10">{UPGRADE_COMMAND}</code>
        <button
          onClick={() => void copyCommand()}
          className="px-2 py-0.5 rounded text-xs font-semibold bg-current/10 hover:bg-current/20 transition-colors"
        >
          Copy
        </button>
        <button
          onClick={onDismiss}
          className="opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss update notice"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
