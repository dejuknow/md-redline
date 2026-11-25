import { Tooltip } from './Tooltip';

interface Props {
  diffEnabled: boolean;
  referenceLabel?: string;
  diffChunkCount: number;
  onDiffPrev: () => void;
  onDiffNext: () => void;
  onMarkReviewed: () => void;
}

const navButtonClass =
  'p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors';

/**
 * Row under the tab strip for reviewing changes. It shows while the diff
 * overlay is on, or while there are changes to review with the overlay off:
 * Mark reviewed has to stay reachable without turning the overlay on, as it
 * was in the old panel toolbar. The reference label and prev/next only mean
 * something while the overlay paints the changes, so they wait for it.
 */
export function DiffBar({
  diffEnabled,
  referenceLabel,
  diffChunkCount,
  onDiffPrev,
  onDiffNext,
  onMarkReviewed,
}: Props) {
  if (!diffEnabled && diffChunkCount === 0) return null;

  return (
    <div
      data-diff-bar
      className="h-9 flex items-center gap-2 px-3 border-b border-border-subtle text-[13px] shrink-0"
    >
      <span className="text-content-secondary tabular-nums whitespace-nowrap">
        {diffChunkCount === 0
          ? 'No changes'
          : diffChunkCount === 1
            ? '1 change'
            : `${diffChunkCount} changes`}
      </span>

      {diffEnabled && referenceLabel && (
        <span
          className="text-content-muted whitespace-nowrap truncate min-w-0"
          data-testid="diff-reference-label"
        >
          {referenceLabel}
        </span>
      )}

      {diffEnabled && diffChunkCount > 0 && (
        <div className="flex items-center gap-0.5">
          <Tooltip text="Previous change">
            <button
              type="button"
              className={navButtonClass}
              onClick={onDiffPrev}
              aria-label="Previous change"
              title="Previous change"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="Next change">
            <button
              type="button"
              className={navButtonClass}
              onClick={onDiffNext}
              aria-label="Next change"
              title="Next change"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                />
              </svg>
            </button>
          </Tooltip>
        </div>
      )}

      {/* Mark reviewed advances the diff reference to the current version. */}
      {diffChunkCount > 0 && (
        <button
          type="button"
          className="rounded-md px-2 py-0.5 font-medium text-content-secondary hover:text-content hover:bg-tint transition-colors whitespace-nowrap"
          onClick={onMarkReviewed}
          title="Mark reviewed"
        >
          Mark reviewed
        </button>
      )}
    </div>
  );
}
