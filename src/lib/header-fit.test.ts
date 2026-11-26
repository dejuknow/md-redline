import { describe, expect, it } from 'vitest';
import {
  INITIAL_HEADER_FIT,
  UNFOLD_HYSTERESIS,
  nextHeaderFit,
  rowSlotMinWidth,
  type HeaderMeasure,
} from './header-fit';

const rowA = {} as Element;
const rowB = {} as Element;
const m = (over: Partial<HeaderMeasure>): HeaderMeasure => ({
  width: 1000,
  minContent: 800,
  floorContent: 800,
  actions: 400,
  rowNeed: 560,
  row: rowA,
  ...over,
});

describe('nextHeaderFit', () => {
  it('stays wide while the content fits, returning the same state', () => {
    const start = nextHeaderFit(INITIAL_HEADER_FIT, m({}));
    expect(start.compact).toBe(false);
    expect(nextHeaderFit(start, m({}))).toBe(start);
  });

  it('folds when the content overflows, then learns what folding saved', () => {
    const folded = nextHeaderFit(INITIAL_HEADER_FIT, m({ minContent: 1050, actions: 400 }));
    expect(folded).toMatchObject({ compact: true, wideActions: 400 });
    const measured = nextHeaderFit(folded, m({ minContent: 910, actions: 260 }));
    expect(measured).toMatchObject({ compact: true, folded: 140, wideActions: null });
    expect(nextHeaderFit(measured, m({ minContent: 910, actions: 260 }))).toBe(measured);
  });

  it('unfolds only once the wide row fits with the hysteresis to spare', () => {
    const folded = { compact: true, folded: 140, wideActions: null, row: rowA };
    expect(nextHeaderFit(folded, m({ width: 1050, minContent: 910, actions: 260 })).compact).toBe(
      true,
    );
    expect(
      nextHeaderFit(folded, m({ width: 1050 + UNFOLD_HYSTERESIS, minContent: 910, actions: 260 }))
        .compact,
    ).toBe(false);
  });

  it('does not flip-flop: a wide row that just folded never unfolds at the same width', () => {
    let fit = nextHeaderFit(INITIAL_HEADER_FIT, m({ width: 1000, minContent: 1001, actions: 400 }));
    for (let i = 0; i < 4; i++) {
      fit = nextHeaderFit(fit, m({ width: 1000, minContent: 861, actions: 260 }));
      expect(fit.compact).toBe(true);
    }
  });

  it('tries another review wide when it takes the folded row', () => {
    const folded = { compact: true, folded: 140, wideActions: null, row: rowA };
    expect(nextHeaderFit(folded, m({ row: rowB, minContent: 990 }))).toMatchObject({
      compact: false,
      row: rowB,
    });
  });

  it('keeps its state while the header is not laid out', () => {
    const folded = { compact: true, folded: 140, wideActions: null, row: rowA };
    expect(nextHeaderFit(folded, m({ width: 0, minContent: 0 }))).toBe(folded);
  });
});

describe('rowSlotMinWidth', () => {
  it("is the row's least width while everything fits with the notice at its least", () => {
    // A full notice would not fit, but the notice gives way before the row.
    expect(
      rowSlotMinWidth(m({ width: 1000, minContent: 1200, floorContent: 900, rowNeed: 500 })),
    ).toBe(500);
  });

  it('gives up what the header lacks past that, and never goes negative', () => {
    expect(rowSlotMinWidth(m({ width: 1000, floorContent: 1120, rowNeed: 500 }))).toBe(380);
    expect(rowSlotMinWidth(m({ width: 300, floorContent: 1120, rowNeed: 500 }))).toBe(0);
  });
});
