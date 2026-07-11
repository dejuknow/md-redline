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

  it('caps the column at the docWidth setting instead of COL_MAX', () => {
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.narrow).colWidth).toBe(560);
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.wide).colWidth).toBe(800);
    // The wide page still fits: 48 + 800 + 360
    expect(pageGeometry(2000, true, DOC_WIDTH_COLS.wide).pageWidth).toBe(1208);
    // The rail threshold is colMax-independent (COL_MIN governs it).
    expect(pageGeometry(888, true, DOC_WIDTH_COLS.wide).railFits).toBe(true);
    expect(pageGeometry(887, true, DOC_WIDTH_COLS.narrow).railFits).toBe(false);
  });
});
