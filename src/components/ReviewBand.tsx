import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  INITIAL_HEADER_FIT,
  measureHeader,
  nextHeaderFit,
  rowSlotMinWidth,
} from '../lib/header-fit';

export interface ReviewBandProps {
  /** The review row, given whether to render it compact. */
  renderBanner: (compact: boolean) => React.ReactNode;
}

/**
 * The review row, as a band across the top of the document panel above the
 * tabs. Mounted only while a review is shown, so with no review the panel's
 * top lines up with the sidebar's.
 *
 * The row folds its secondary actions into a menu by measured fit (see
 * header-fit.ts), not by a breakpoint. Its left padding reads
 * `--window-inset-left`, which a desktop shell sets to clear its window
 * controls when the sidebar no longer covers them.
 */
export function ReviewBand({ renderBanner }: ReviewBandProps) {
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
  // And on what changes without a render here: the panel's width, and the
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

  return (
    <header
      ref={rootRef}
      data-review-band
      className="h-11 shrink-0 min-w-0 flex items-center gap-2 pr-0.5 text-content"
      // Adds to the band's own inset rather than replacing it.
      style={{ paddingLeft: 'calc(var(--window-inset-left, 0px) + 0.25rem)' }}
    >
      {/* Its min-width is set from measurements (see measure above). */}
      <div ref={slotRef} data-header-banner className="min-w-0 flex-1 flex">
        {renderBanner(fit.compact)}
      </div>
    </header>
  );
}
