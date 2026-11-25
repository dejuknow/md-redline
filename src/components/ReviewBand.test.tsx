// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReviewBand } from './ReviewBand';
import { UNFOLD_HYSTERESIS, type HeaderMeasure } from '../lib/header-fit';

// The band measures its row to decide whether it folds. jsdom has no layout,
// so the measurements come from here; the decision itself is the real
// nextHeaderFit.
let mockMeasure: HeaderMeasure | null | ((compact: boolean) => HeaderMeasure) = null;
vi.mock('../lib/header-fit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/header-fit')>();
  return {
    ...actual,
    // A function reads the layout on screen, the way the real one does.
    measureHeader: () =>
      typeof mockMeasure === 'function'
        ? mockMeasure(document.querySelector('[data-compact="true"]') !== null)
        : mockMeasure,
  };
});

beforeEach(() => {
  mockMeasure = null;
});
afterEach(cleanup);

const band = () => document.querySelector('[data-review-band]') as HTMLElement;

const row = document.createElement('div');
const measured = (m: Partial<HeaderMeasure>): HeaderMeasure => ({
  width: 1000,
  minContent: 800,
  floorContent: 800,
  actions: 400,
  rowNeed: 560,
  row,
  ...m,
});

describe('ReviewBand', () => {
  it('renders the review row and adds --window-inset-left to its own left padding', () => {
    render(<ReviewBand renderBanner={() => <div data-testid="review-banner" />} />);
    expect(band()).toBeTruthy();
    expect(screen.getByTestId('review-banner')).toBeTruthy();
    expect(band().style.paddingLeft).toBe('calc(var(--window-inset-left, 0px) + 0.25rem)');
  });

  it('folds the review row when its content does not fit, and unfolds only past the hysteresis', () => {
    const renderBanner = vi.fn((compact: boolean) => (
      <div data-testid="review-banner" data-compact={String(compact)} />
    ));
    // The wide row needs 1050px in a 1000px band, so it folds; folded, its
    // actions measure 260px, 140px less than the 400px wide.
    let width = 1000;
    mockMeasure = (compact) =>
      compact
        ? measured({ width, minContent: 910, actions: 260 })
        : measured({ width, minContent: 1050, actions: 400 });
    const { rerender } = render(<ReviewBand renderBanner={renderBanner} />);
    expect(renderBanner).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('review-banner').getAttribute('data-compact')).toBe('true');

    // Wide would fit at 910 + 140 = 1050px, but that is inside the hysteresis.
    width = 1060;
    rerender(<ReviewBand renderBanner={renderBanner} />);
    expect(renderBanner).toHaveBeenLastCalledWith(true);

    width = 1050 + UNFOLD_HYSTERESIS;
    rerender(<ReviewBand renderBanner={renderBanner} />);
    expect(renderBanner).toHaveBeenLastCalledWith(false);
  });

  it('keeps the review row from narrowing past its least width', () => {
    const renderBanner = () => <div data-testid="review-banner" />;
    mockMeasure = measured({ width: 1000, minContent: 800, rowNeed: 560 });
    render(<ReviewBand renderBanner={renderBanner} />);
    const slot = band().querySelector('[data-header-banner]') as HTMLElement;
    expect(slot.style.minWidth).toBe('560px');
  });

  it('treats an unmeasured band (no layout) as wide', () => {
    const renderBanner = vi.fn(() => <div data-testid="review-banner" />);
    mockMeasure = measured({ width: 0, minContent: 5000 });
    render(<ReviewBand renderBanner={renderBanner} />);
    expect(renderBanner).toHaveBeenLastCalledWith(false);
  });
});
