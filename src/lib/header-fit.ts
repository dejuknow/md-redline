/**
 * Whether the app header's review row fits wide or must fold its secondary
 * actions into a menu (compact), decided from measured widths rather than a
 * fixed breakpoint: the row's actions, the notice and focus mode's Exit focus
 * all change what fits.
 */

/** The least room the review row's status keeps before the row folds. */
export const MIN_STATUS_WIDTH = 160;
/** The least room a header notice keeps once even the folded row needs the space. */
export const MIN_NOTICE_WIDTH = 96;
/** Extra room the wide row needs before it unfolds again, so it does not flip-flop. */
export const UNFOLD_HYSTERESIS = 24;

export interface HeaderMeasure {
  /** The header's inner width (padding excluded). */
  width: number;
  /**
   * What the header's content needs for the row to stay wide: gaps, items
   * that cannot shrink at their width, a notice in full (up to its cap), the
   * review row's status at `MIN_STATUS_WIDTH` (or its own width, if shorter)
   * and its actions in full. The row folds before the notice gives way.
   */
  minContent: number;
  /** The same with a notice at its least (`MIN_NOTICE_WIDTH`): the true floor. */
  floorContent: number;
  /** The review row's trailing group (Other reviews and the actions). */
  actions: number;
  /** The review row's least width as rendered: status at its least, actions in full. */
  rowNeed: number;
  /** That group's element: a new one means another review took the row. */
  row: Element | null;
}

export interface HeaderFit {
  compact: boolean;
  /** While compact: how much wider the row's actions are unfolded. */
  folded: number;
  /** The wide actions' width, kept from the fold until the compact one is measured. */
  wideActions: number | null;
  row: Element | null;
}

export const INITIAL_HEADER_FIT: HeaderFit = {
  compact: false,
  folded: 0,
  wideActions: null,
  row: null,
};

/** The next layout for a measurement; returns `prev` itself when nothing changes. */
export function nextHeaderFit(prev: HeaderFit, m: HeaderMeasure): HeaderFit {
  // Not laid out (hidden during start-up, or no layout at all): keep what we have.
  if (m.width <= 0) return prev;
  if (!prev.compact) {
    if (m.minContent > m.width + 0.5) {
      return { compact: true, folded: 0, wideActions: m.actions, row: m.row };
    }
    return prev.row === m.row ? prev : { ...prev, row: m.row };
  }
  // Another review took the row while folded: what its actions add back is
  // unknown, so try it wide. If that does not fit, it folds again, measured.
  if (prev.row !== m.row) return { ...INITIAL_HEADER_FIT, row: m.row };
  const folded =
    prev.wideActions !== null ? Math.max(0, prev.wideActions - m.actions) : prev.folded;
  if (m.minContent + folded + UNFOLD_HYSTERESIS <= m.width) {
    return { ...INITIAL_HEADER_FIT, row: m.row };
  }
  if (folded === prev.folded && prev.wideActions === null) return prev;
  return { compact: true, folded, wideActions: null, row: m.row };
}

const px = (v: string) => parseFloat(v) || 0;

/**
 * Measures the header for `nextHeaderFit`, or null when it shows no review
 * row. Reads `[data-header-banner]` (the review row's slot), the row's
 * `[data-row-status]` text and `[data-row-end]` group; any other item counts
 * at its width when it cannot shrink, else at its CSS min-width (a notice at
 * `MIN_NOTICE_WIDTH`).
 */
export function measureHeader(root: HTMLElement): HeaderMeasure | null {
  const slot = root.querySelector<HTMLElement>('[data-header-banner]');
  const end = slot?.querySelector<HTMLElement>('[data-row-end]');
  const text = slot?.querySelector<HTMLElement>('[data-row-status]');
  if (!slot || !end || !text) return null;
  const statusGroup = text.parentElement as HTMLElement;
  const rowEl = statusGroup.parentElement as HTMLElement;

  const cs = getComputedStyle(root);
  const width = root.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const actions = end.getBoundingClientRect().width;
  // The status group without its text, plus the text at its least.
  const statusMin =
    statusGroup.getBoundingClientRect().width -
    text.getBoundingClientRect().width +
    Math.min(text.scrollWidth, MIN_STATUS_WIDTH);
  const rowNeed = statusMin + px(getComputedStyle(rowEl).columnGap) + actions;

  const kids = Array.from(root.children) as HTMLElement[];
  let fixed = px(cs.columnGap) * Math.max(0, kids.length - 1) + rowNeed;
  let notice = 0;
  for (const el of kids) {
    if (el === slot) continue;
    const style = getComputedStyle(el);
    if (el.hasAttribute('data-header-notices')) {
      // `max-w-[40%]` of the header's content box.
      notice = Math.min(naturalWidth(el), width * 0.4);
    } else if (style.flexShrink === '0') {
      fixed += el.getBoundingClientRect().width;
    } else {
      fixed += Math.min(el.getBoundingClientRect().width, px(style.minWidth));
    }
  }
  return {
    width,
    minContent: fixed + notice,
    floorContent: fixed + Math.min(notice, MIN_NOTICE_WIDTH),
    actions,
    rowNeed,
    row: end,
  };
}

// An element's width with nothing truncated: a flex row's is its children's
// (and gaps and padding), anything else's its scroll width, which for a
// truncating text span is its whole text.
function naturalWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  if (!style.display.endsWith('flex')) return el.scrollWidth;
  const kids = Array.from(el.children) as HTMLElement[];
  return (
    kids.reduce((sum, kid) => sum + naturalWidth(kid), 0) +
    px(style.columnGap) * Math.max(0, kids.length - 1) +
    px(style.paddingLeft) +
    px(style.paddingRight)
  );
}

/**
 * The review row's slot never narrows past the row's least width, so its
 * actions never run under the notice: a notice gives way first, down to its
 * least. Only when even that leaves no room for the header's other items
 * does the row give up the difference, so the palette chip and Exit focus
 * stay in the header.
 */
export function rowSlotMinWidth(m: HeaderMeasure): number {
  return Math.max(0, m.rowNeed - Math.max(0, m.floorContent - m.width));
}
