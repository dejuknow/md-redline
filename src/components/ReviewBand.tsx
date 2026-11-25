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
 * The review row, docked along the bottom edge of the page card, full width
 * under the document and the comments column. Mounted only while a review is
 * shown. Down here a review starting or ending moves nothing above it: the
 * tabs and the text stay put and the page's scroll area gets shorter instead.
 * It slides up as it mounts so a review that starts mid-read is noticed, and
 * while it is mounted toasts and the update notice sit above it: it sets
 * `--review-dock-offset` on the root, which their bottom offsets add.
 *
 * It is tinted crimson with a crimson top line so it reads as work waiting on
 * the reader, not a status footer, and the review's tabs carry a matching
 * line (TabBar), so the cue also shows up top where the reader is looking.
 *
 * The row folds its secondary actions into a menu by measured fit (see
 * header-fit.ts), not by a breakpoint; its menus open upward.
 */
/** The docked row's height (its h-11), which toasts clear while it shows. */
const REVIEW_DOCK_HEIGHT = 44;

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
  // Set from here rather than a :root:has() rule, which would make the browser
  // re-check the whole page on every DOM change.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--review-dock-offset', `${REVIEW_DOCK_HEIGHT}px`);
    return () => {
      root.style.removeProperty('--review-dock-offset');
    };
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
      className="h-11 shrink-0 min-w-0 flex items-center gap-2 pl-4 pr-2 border-t-2 border-primary bg-primary-bg rounded-b-[9px] text-content motion-safe:animate-[review-dock-in_180ms_ease-out]"
    >
      {/* Its min-width is set from measurements (see measure above). */}
      <div ref={slotRef} data-header-banner className="min-w-0 flex-1 flex">
        {renderBanner(fit.compact)}
      </div>
    </header>
  );
}
