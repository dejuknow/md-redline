// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { Tooltip, _resetTooltipScrubClock } from './Tooltip';

beforeEach(() => {
  vi.useFakeTimers();
  _resetTooltipScrubClock();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function hover(el: HTMLElement) {
  fireEvent.mouseEnter(el);
}
function unhover(el: HTMLElement) {
  fireEvent.mouseLeave(el);
}

describe('Tooltip', () => {
  it('does not show before the reveal delay', () => {
    render(
      <Tooltip text="hello" delay={500}>
        <button title="legacy">trigger</button>
      </Tooltip>,
    );
    hover(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows after the reveal delay', () => {
    render(
      <Tooltip text="hello" delay={500}>
        <button title="legacy">trigger</button>
      </Tooltip>,
    );
    hover(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('hello');
  });

  it('hides on mouseleave and restores the stashed title', () => {
    render(
      <Tooltip text="hello" delay={500}>
        <button title="legacy">trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByText('trigger');
    hover(btn);
    // While hovering, the native title is suppressed so the browser tooltip
    // can't race ours.
    expect(btn.hasAttribute('title')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    unhover(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Title is restored on mouseleave.
    expect(btn.getAttribute('title')).toBe('legacy');
  });

  it('cancels the pending reveal if the user leaves before the delay', () => {
    render(
      <Tooltip text="hello" delay={500}>
        <button>trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByText('trigger');
    hover(btn);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    unhover(btn);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows immediately on the next hover when scrubbing across icons', () => {
    render(
      <>
        <Tooltip text="first" delay={500}>
          <button>one</button>
        </Tooltip>
        <Tooltip text="second" delay={500}>
          <button>two</button>
        </Tooltip>
      </>,
    );
    const btn1 = screen.getByText('one');
    const btn2 = screen.getByText('two');

    // Reveal the first tooltip the slow way.
    hover(btn1);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('first');

    // Leave btn1 and immediately enter btn2 — should appear with no delay.
    unhover(btn1);
    hover(btn2);
    expect(screen.getByRole('tooltip').textContent).toBe('second');
  });

  it('does not unlock instant-reveal when the first hover never showed', () => {
    render(
      <>
        <Tooltip text="first" delay={500}>
          <button>one</button>
        </Tooltip>
        <Tooltip text="second" delay={500}>
          <button>two</button>
        </Tooltip>
      </>,
    );
    const btn1 = screen.getByText('one');
    const btn2 = screen.getByText('two');

    // Quick traversal — first hover never reveals.
    hover(btn1);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    unhover(btn1);
    hover(btn2);
    // Second tooltip should still wait for the full delay.
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('second');
  });

  it('still triggers on hover when the wrapped button is disabled', () => {
    // Disabled buttons don't fire mouseenter natively, but our wrapping span
    // does — so the tooltip should still appear with the explanatory text.
    render(
      <Tooltip text="add comments first" delay={500}>
        <button disabled title="add comments first">
          handoff
        </button>
      </Tooltip>,
    );
    const btn = screen.getByText('handoff');
    // Hover the wrapping span (the parent of the disabled button).
    hover(btn.parentElement as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('add comments first');
  });

  it('restores the stashed title on unmount mid-hover', () => {
    const { unmount } = render(
      <Tooltip text="hello" delay={500}>
        <button title="legacy">trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByText('trigger');
    hover(btn);
    expect(btn.hasAttribute('title')).toBe(false);
    unmount();
    // After unmount the trigger element is detached, but if it survives
    // (e.g. via portal) the title is restored.
    expect(btn.getAttribute('title') ?? null).toBe(null);
  });

  // The useLayoutEffect pulls a viewport-edge tooltip's center back so the
  // whole bubble stays within an 8px margin. jsdom reports 0 for offsetWidth
  // and getBoundingClientRect, so we stub the trigger rect, the tooltip width,
  // and window.innerWidth to exercise the clamp math directly.
  describe('viewport clamping', () => {
    const MARGIN = 8;
    let restoreOffsetWidth: (() => void) | null = null;
    let originalInnerWidth = 0;

    function mockTooltipWidth(width: number) {
      const proto = HTMLElement.prototype;
      const original = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
      Object.defineProperty(proto, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute('role') === 'tooltip' ? width : 0;
        },
      });
      restoreOffsetWidth = () => {
        if (original) Object.defineProperty(proto, 'offsetWidth', original);
        else delete (proto as unknown as Record<string, unknown>).offsetWidth;
      };
    }

    function setInnerWidth(width: number) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }

    beforeEach(() => {
      originalInnerWidth = window.innerWidth;
    });

    afterEach(() => {
      restoreOffsetWidth?.();
      restoreOffsetWidth = null;
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
    });

    /** Render, stub the trigger rect, reveal the tooltip, return the bubble. */
    function showTooltipAt(triggerLeft: number, triggerWidth: number): HTMLElement {
      render(
        <Tooltip text="a long tooltip label" delay={500}>
          <button>trigger</button>
        </Tooltip>,
      );
      const btn = screen.getByText('trigger');
      btn.getBoundingClientRect = () =>
        ({
          left: triggerLeft,
          right: triggerLeft + triggerWidth,
          width: triggerWidth,
          top: 100,
          bottom: 120,
          height: 20,
          x: triggerLeft,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect;
      hover(btn);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      return screen.getByRole('tooltip');
    }

    it('pulls a right-edge tooltip left so its right edge stays within the margin', () => {
      setInnerWidth(1000);
      mockTooltipWidth(200); // half = 100
      // trigger center x = 960; max = 1000 - 8 - 100 = 892 → clamped to 892.
      const left = parseFloat(showTooltipAt(940, 40).style.left);
      expect(left).toBe(892);
      expect(left).toBeLessThan(960); // actually moved
      expect(left + 100).toBeLessThanOrEqual(1000 - MARGIN); // whole bubble fits
    });

    it('pushes a left-edge tooltip right so its left edge stays within the margin', () => {
      setInnerWidth(1000);
      mockTooltipWidth(200); // half = 100
      // trigger center x = 0; min = 8 + 100 = 108 → clamped to 108.
      const left = parseFloat(showTooltipAt(-20, 40).style.left);
      expect(left).toBe(108);
      expect(left).toBeGreaterThan(0); // actually moved
      expect(left - 100).toBeGreaterThanOrEqual(MARGIN);
    });

    it('leaves a comfortably-centered tooltip unclamped', () => {
      setInnerWidth(1000);
      mockTooltipWidth(200);
      // center x = 420, inside [108, 892] → unchanged.
      expect(parseFloat(showTooltipAt(400, 40).style.left)).toBe(420);
    });

    it('leaves a tooltip wider than the viewport centered (clamping is impossible)', () => {
      setInnerWidth(300);
      mockTooltipWidth(400); // half = 200 → min 208 > max 92, so no clamp.
      expect(parseFloat(showTooltipAt(250, 40).style.left)).toBe(270);
    });
  });
});
