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
export const DOC_WIDTH_COLS = { narrow: 520, default: COL_MAX, wide: 860 } as const;

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
 * and the freed width goes to the column rather than to the canvas: a
 * comment-free document reads at its full Document width instead of sitting
 * narrow between two dead margins.
 *
 * The cost is a reflow whenever the open-comment count crosses 0 and 1 in
 * either direction, since the column swaps tracks: adding the first comment,
 * and equally resolving, deleting or unresolving the last one. It only
 * rewraps text between 888 and 1080 of content width; above that both tracks
 * clamp to colMax and only the sheet moves. That is the deliberate trade for
 * every comment-free document reading at full measure. railShown is
 * unaffected, so the rail chrome (density toggle, open count) stays visible.
 */
export function pageGeometry(
  contentWidth: number,
  railAllowed: boolean,
  colMax: number = COL_MAX,
  reserveRail: boolean = true,
): PageGeometry {
  // The column with nothing reserved to its right: the whole sheet minus
  // symmetric padding, capped by the Document width setting. Both the
  // collapsed-gutter case and the no-rail case land here, so an empty margin
  // is never wider than the text it sits next to.
  const fullCol = Math.max(Math.min(contentWidth - 2 * PAD_L, colMax), 320);
  const railCol = contentWidth - PAD_L - RAIL_FOOTPRINT;
  const railFits = railCol >= COL_MIN;
  if (railAllowed && railFits) {
    if (!reserveRail) {
      return {
        railFits,
        railShown: true,
        colWidth: fullCol,
        pageWidth: PAD_L + fullCol + PAD_L,
      };
    }
    const colWidth = Math.min(railCol, colMax);
    return {
      railFits,
      railShown: true,
      colWidth,
      pageWidth: PAD_L + colWidth + RAIL_FOOTPRINT,
    };
  }
  return { railFits, railShown: false, colWidth: fullCol, pageWidth: PAD_L + fullCol + PAD_L };
}
