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

export interface PageGeometry {
  /** The rail fits by width alone (>= 888px content width). */
  railFits: boolean;
  /** The rail actually shows: railFits AND railAllowed. */
  railShown: boolean;
  colWidth: number;
  pageWidth: number;
}

export function pageGeometry(contentWidth: number, railAllowed: boolean): PageGeometry {
  const railCol = contentWidth - PAD_L - RAIL_FOOTPRINT;
  const railFits = railCol >= COL_MIN;
  if (railAllowed && railFits) {
    const colWidth = Math.min(railCol, COL_MAX);
    return { railFits, railShown: true, colWidth, pageWidth: PAD_L + colWidth + RAIL_FOOTPRINT };
  }
  const colWidth = Math.max(Math.min(contentWidth - 2 * PAD_L, COL_MAX), 320);
  return { railFits, railShown: false, colWidth, pageWidth: PAD_L + colWidth + PAD_L };
}
