/**
 * Remove the `review` query param from the address bar via
 * history.replaceState. Safe to call when the param isn't present
 * (no-op). Used after a review session resolves so a page reload
 * doesn't re-open the tabs of a completed review.
 */
export function stripReviewParamFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('review')) return;
    url.searchParams.delete('review');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* URL parsing failed — no-op. */
  }
}
