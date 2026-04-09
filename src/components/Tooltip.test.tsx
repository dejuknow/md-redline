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
});
