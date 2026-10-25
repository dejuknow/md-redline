// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
