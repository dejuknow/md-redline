// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Toast } from './Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const undo = { label: 'Undo', onClick: () => {} };

// Two deletes in a row show the same text ("Comment deleted."), each with its
// own Undo. Keying the timers on the message alone let the second toast inherit
// the first one's clock, or the first one's pending fade-out.
describe('Toast shown again with the same message', () => {
  it('restarts the auto-dismiss timer', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );

    vi.advanceTimersByTime(4000);
    rerender(
      <Toast message="Comment deleted." visible toastId={2} onDismiss={onDismiss} action={undo} />,
    );
    vi.advanceTimersByTime(2000);
    expect(onDismiss).not.toHaveBeenCalled();

    // 5s on screen plus the 200ms fade, counted from the second toast.
    vi.advanceTimersByTime(3300);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('is not dismissed by the previous toast fading out', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );

    // The first toast times out and starts its 200ms fade.
    vi.advanceTimersByTime(5100);
    rerender(
      <Toast message="Comment deleted." visible toastId={2} onDismiss={onDismiss} action={undo} />,
    );
    vi.advanceTimersByTime(300);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// A toast with a button gets a bar that runs down over its 5 seconds, so it is
// plain that it will close on its own, and when. Reaching for the button stops
// the clock: pointing at the toast or focusing a control inside it pauses both
// the bar and the timer, and leaving resumes with the time that was left.
describe('Toast countdown', () => {
  const bar = () => document.querySelector<HTMLElement>('[data-toast-countdown]');

  it('shows a countdown bar on a toast with an action', () => {
    render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={() => {}} action={undo} />,
    );
    expect(bar()).not.toBeNull();
    expect(bar()!.style.animationDuration).toBe('5000ms');
  });

  it('shows no countdown on a toast without an action', () => {
    render(<Toast message="Saved." visible toastId={1} onDismiss={() => {}} />);
    expect(bar()).toBeNull();
  });

  it('pauses while pointed at and resumes with the time that was left', () => {
    const onDismiss = vi.fn();
    render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );
    const toast = screen.getByRole('status');

    vi.advanceTimersByTime(3000);
    fireEvent.mouseEnter(toast);
    expect(bar()!.style.animationPlayState).toBe('paused');
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    expect(bar()!.style.animationPlayState).toBe('running');
    vi.advanceTimersByTime(1900);
    expect(onDismiss).not.toHaveBeenCalled();
    // The 2s that were left, plus the 200ms fade.
    vi.advanceTimersByTime(400);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pauses while a control inside has keyboard focus', () => {
    const onDismiss = vi.fn();
    render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );
    const button = screen.getByRole('button', { name: 'Undo' });

    vi.advanceTimersByTime(1000);
    fireEvent.focusIn(button);
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.focusOut(button, { relatedTarget: null });
    vi.advanceTimersByTime(4300);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not leave the next toast paused after closing under the pointer', () => {
    // The toast unmounts without a mouseleave when Undo is clicked, so the
    // pointer state has to reset when it hides.
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );
    fireEvent.mouseEnter(screen.getByRole('status'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    vi.advanceTimersByTime(200);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(
      <Toast
        message="Comment deleted."
        visible={false}
        toastId={1}
        onDismiss={onDismiss}
        action={undo}
      />,
    );
    rerender(
      <Toast message="Comment deleted." visible toastId={2} onDismiss={onDismiss} action={undo} />,
    );
    vi.advanceTimersByTime(5200);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('does not start a replacement toast paused when the focused control went away', () => {
    // Undo pressed from the keyboard can fail and swap in "Couldn't undo",
    // which has no button. The focused Undo is removed without a blur, so
    // focus has to be read from the page, not remembered.
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={onDismiss} action={undo} />,
    );
    fireEvent.focusIn(screen.getByRole('button', { name: 'Undo' }));
    rerender(
      <Toast message="Couldn't undo." visible toastId={2} onDismiss={onDismiss} kind="error" />,
    );
    vi.advanceTimersByTime(5200);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('restarts the bar for a new toast with the same text', () => {
    const { rerender } = render(
      <Toast message="Comment deleted." visible toastId={1} onDismiss={() => {}} action={undo} />,
    );
    const first = bar();
    rerender(
      <Toast message="Comment deleted." visible toastId={2} onDismiss={() => {}} action={undo} />,
    );
    expect(bar()).not.toBeNull();
    expect(bar()).not.toBe(first);
  });
});
