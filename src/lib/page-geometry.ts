/**
 * Geometry for the document page unit. The page is a fixed-width sheet
 * centered on the canvas; it holds the prose column and, when there is
 * room, the comments rail. The column shrinks continuously from COL_MAX
 * down to COL_MIN before the rail gives up (spec decision 2).
 */
export const PAD_L = 48;
export const COL_MAX = 672;
export const COL_MIN = 480;
export const GAP = 56;
export const RAIL = 280;
export const PAD_R = 24;
export const RAIL_FOOTPRINT = GAP + RAIL + PAD_R; // 360
export const CANVAS_GUTTER = 24;

/** Prose column caps for the Document width setting. */
export const DOC_WIDTH_COLS = { narrow: 560, default: COL_MAX, wide: 800 } as const;

export interface PageGeometry {
  /** The rail fits by width alone (>= 888px content width). */
  railFits: boolean;
  /** The rail actually shows: railFits AND railAllowed. */
  railShown: boolean;
  colWidth: number;
  pageWidth: number;
}

/**
 * `reserveRail` collapses the empty right gutter while keeping the rail
 * logically shown. When the anchored rail has no cards to place, the sheet
 * drops the rail footprint and re-centers on the prose (symmetric PAD_L),
 * but colWidth stays on the rail-shown track so the prose column never
 * reflows across the transition — only the sheet slides as the gutter opens
 * with the first comment. railShown is unaffected, so the rail's chrome
 * (density toggle, open count) stays visible.
 */
export function pageGeometry(
  contentWidth: number,
  railAllowed: boolean,
  colMax: number = COL_MAX,
  reserveRail: boolean = true,
): PageGeometry {
  const railCol = contentWidth - PAD_L - RAIL_FOOTPRINT;
  const railFits = railCol >= COL_MIN;
  if (railAllowed && railFits) {
    const colWidth = Math.min(railCol, colMax);
    const pageWidth = reserveRail
      ? PAD_L + colWidth + RAIL_FOOTPRINT
      : PAD_L + colWidth + PAD_L;
    return { railFits, railShown: true, colWidth, pageWidth };
  }
  const colWidth = Math.max(Math.min(contentWidth - 2 * PAD_L, colMax), 320);
  return { railFits, railShown: false, colWidth, pageWidth: PAD_L + colWidth + PAD_L };
}
