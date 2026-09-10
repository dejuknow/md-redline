import { describe, it, expect } from 'vitest';
import {
  pageGeometry,
  PAD_L,
  COL_MAX,
  COL_MIN,
  RAIL_FOOTPRINT,
  DOC_WIDTH_COLS,
} from './page-geometry';

describe('pageGeometry', () => {
  it('shows the rail at full column width when there is room', () => {
    // 48 + 672 + 360 = 1080; give it more than that
    const g = pageGeometry(1400, true);
    expect(g).toEqual({ railFits: true, railShown: true, colWidth: 672, pageWidth: 1080 });
  });

  it('shrinks the column continuously before hiding the rail', () => {
    // contentWidth 1000: col = 1000 - 48 - 360 = 592 (between 480 and 672)
    const g = pageGeometry(1000, true);
    expect(g.railFits).toBe(true);
    expect(g.colWidth).toBe(592);
    expect(g.pageWidth).toBe(PAD_L + 592 + RAIL_FOOTPRINT);
  });

  it('keeps the rail exactly at the 480 column floor', () => {
    // threshold: 48 + 480 + 360 = 888
    const g = pageGeometry(888, true);
    expect(g.railFits).toBe(true);
    expect(g.colWidth).toBe(COL_MIN);
  });

  it('hides the rail below the threshold and re-centers at up to 672', () => {
    const g = pageGeometry(887, true);
    expect(g.railFits).toBe(false);
    expect(g.colWidth).toBe(Math.min(887 - 2 * PAD_L, COL_MAX));
    expect(g.pageWidth).toBe(PAD_L + g.colWidth + PAD_L);
  });

  it('caps the no-rail page at 768', () => {
    const g = pageGeometry(2000, false);
    expect(g).toEqual({ railFits: true, railShown: false, colWidth: COL_MAX, pageWidth: 768 });
  });

  it('railAllowed=false forces the no-rail layout but still reports the width fit', () => {
    const g = pageGeometry(1400, false);
    expect(g.railFits).toBe(true);
    expect(g.railShown).toBe(false);
    expect(g.pageWidth).toBe(768);
  });

  it('never returns a column below the 320 hard floor', () => {
    const g = pageGeometry(300, true);
    expect(g.railFits).toBe(false);
    expect(g.colWidth).toBe(320);
  });

  it('collapses the empty gutter and keeps the rail shown', () => {
    // Same width as the full-rail case, but the anchored rail has no cards.
    const reserved = pageGeometry(1400, true);
    const collapsed = pageGeometry(1400, true, COL_MAX, false);
    // The rail stays logically shown, so its chrome and focus routing are
    // unchanged; only the sheet loses the footprint it has nothing to put in.
    expect(collapsed.railShown).toBe(true);
    expect(collapsed.pageWidth).toBe(PAD_L + collapsed.colWidth + PAD_L);
    expect(collapsed.pageWidth).toBeLessThan(reserved.pageWidth);
  });

  it('gives the collapsed gutter to the column, not to the canvas', () => {
    // 1000px: the rail-shown column is 592, but with no card to place the
    // 360px footprint belongs to the prose. Anything less leaves a
    // comment-free document narrow between two dead margins.
    const collapsed = pageGeometry(1000, true, COL_MAX, false);
    expect(collapsed.colWidth).toBe(Math.min(1000 - 2 * PAD_L, COL_MAX));
    expect(collapsed.colWidth).toBeGreaterThan(pageGeometry(1000, true).colWidth);
    expect(collapsed.pageWidth).toBe(PAD_L + collapsed.colWidth + PAD_L);
  });

  it('lays a collapsed gutter out exactly like the no-rail case', () => {
    // The two states differ only in whether the rail chrome is mounted, so
    // their geometry must not drift apart.
    for (const w of [900, 1000, 1200, 1400, 2000]) {
      const collapsed = pageGeometry(w, true, COL_MAX, false);
      const noRail = pageGeometry(w, false);
      expect(collapsed.colWidth).toBe(noRail.colWidth);
      expect(collapsed.pageWidth).toBe(noRail.pageWidth);
    }
  });

  it('respects the docWidth cap when the gutter collapses', () => {
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.narrow, false).colWidth).toBe(520);
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.wide, false).colWidth).toBe(860);
  });

  it('ignores reserveRail when the rail cannot fit by width', () => {
    // Below the fit threshold: the no-rail layout is used regardless.
    expect(pageGeometry(887, true, COL_MAX, false)).toEqual(pageGeometry(887, true));
  });

  it('caps the column at the docWidth setting instead of COL_MAX', () => {
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.narrow).colWidth).toBe(520);
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.wide).colWidth).toBe(860);
    // The wide page still fits: 48 + 860 + 360
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.wide).pageWidth).toBe(1268);
    // The rail threshold is colMax-independent (COL_MIN governs it).
    expect(pageGeometry(888, true, DOC_WIDTH_COLS.wide).railFits).toBe(true);
    expect(pageGeometry(887, true, DOC_WIDTH_COLS.narrow).railFits).toBe(false);
  });
});
