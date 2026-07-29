// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { useSelection } from './useSelection';
import type { SelectionInfo } from '../types';

vi.mock('../lib/selection-resolver', () => ({
  resolveSelection: vi.fn(),
}));

import { resolveSelection } from '../lib/selection-resolver';

const mockResolve = vi.mocked(resolveSelection);

const INFO: SelectionInfo = {
  text: 'selected text',
  rect: new DOMRect(0, 0, 10, 10),
  contextBefore: '',
  contextAfter: '',
  offset: 0,
};

let result: { current: ReturnType<typeof useSelection> };
const hook = () => result.current;

function pointerDown(pointerType: string) {
  const e = new Event('pointerdown');
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  act(() => {
    document.dispatchEvent(e);
  });
}

function mouseUp() {
  act(() => {
    document.dispatchEvent(new Event('mouseup'));
  });
}

function selectionChange() {
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockResolve.mockReturnValue(INFO);
  // Stable ref object, like the useRef the app passes — a fresh object per
  // render would re-run the hook's listener effect and reset gesture state.
  const containerRef = { current: document.body };
  ({ result } = renderHook(() => useSelection(containerRef)));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useSelection modality routing', () => {
  it('opens the selection immediately on mouseup for mouse gestures', () => {
    pointerDown('mouse');
    mouseUp();
    expect(hook().selection).toEqual(INFO);
    expect(hook().pendingSelection).toBeNull();
  });

  it('does not open on mouseup when the gesture was touch', () => {
    pointerDown('touch');
    mouseUp();
    expect(hook().selection).toBeNull();
  });

  it('captures touch selections as pending instead of opening', () => {
    pointerDown('touch');
    selectionChange();
    expect(hook().selection).toBeNull();
    expect(hook().pendingSelection).toEqual(INFO);
  });

  it('captures pen selections as pending', () => {
    pointerDown('pen');
    selectionChange();
    expect(hook().pendingSelection).toEqual(INFO);
  });

  it('ignores selectionchange for mouse gestures', () => {
    pointerDown('mouse');
    selectionChange();
    expect(hook().pendingSelection).toBeNull();
  });

  it('promotes pending to selection on commit', () => {
    pointerDown('touch');
    selectionChange();
    act(() => hook().commitPendingSelection());
    expect(hook().selection).toEqual(INFO);
    expect(hook().pendingSelection).toBeNull();
  });

  it('commit is a no-op without a pending selection', () => {
    act(() => hook().commitPendingSelection());
    expect(hook().selection).toBeNull();
  });

  // Originally asserted on commitPendingSelection alone. The app only reaches
  // that through lockSelection, which also locks, and an unlocked committed
  // selection deliberately no longer blocks capture (see the supersede test
  // below), so this now drives the path the app actually takes.
  it('stops capturing pending while a selection is locked', () => {
    pointerDown('touch');
    selectionChange();
    act(() => hook().lockSelection());
    mockResolve.mockReturnValue({ ...INFO, text: 'other' });
    selectionChange();
    expect(hook().pendingSelection).toBeNull();
    expect(hook().selection).toEqual(INFO);
  });

  // A pill showing for an unlocked mouse selection must not swallow a touch
  // selection made elsewhere. Gating capture on "anything committed" dropped
  // those silently and left the stale pill over the old text, while the mouse
  // path always overrode, so the two modalities disagreed.
  it('a touch selection supersedes an unlocked mouse selection', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'MOUSE-A' });
    pointerDown('mouse');
    mouseUp();
    expect(hook().selection?.text).toBe('MOUSE-A');

    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-B' });
    pointerDown('touch');
    selectionChange();

    expect(hook().pendingSelection?.text).toBe('TOUCH-B');
    expect(hook().selection).toBeNull();
  });

  it('re-arms the pending flow after clearSelection', () => {
    pointerDown('touch');
    selectionChange();
    act(() => hook().commitPendingSelection());
    act(() => hook().clearSelection());
    selectionChange();
    expect(hook().pendingSelection).toEqual(INFO);
  });

  it('clears pending when the selection collapses', () => {
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection).toEqual(INFO);
    mockResolve.mockReturnValue(null);
    selectionChange();
    expect(hook().pendingSelection).toBeNull();
  });

  it('Escape clears both pending and committed selections', () => {
    pointerDown('touch');
    selectionChange();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    });
    expect(hook().pendingSelection).toBeNull();
    expect(hook().selection).toBeNull();
  });

  // A mouse gesture supersedes any pending touch selection. Without that,
  // onLock (which fires on every pill interaction) would resurrect the stale
  // touch selection and anchor the comment to the wrong text.
  it('a mouse selection clears a pending touch selection', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-A' });
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection?.text).toBe('TOUCH-A');

    mockResolve.mockReturnValue({ ...INFO, text: 'MOUSE-B' });
    pointerDown('mouse');
    mouseUp();
    expect(hook().selection?.text).toBe('MOUSE-B');
    expect(hook().pendingSelection).toBeNull();
  });

  it('committing after a mouse selection does not resurrect the touch one', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-A' });
    pointerDown('touch');
    selectionChange();

    mockResolve.mockReturnValue({ ...INFO, text: 'MOUSE-B' });
    pointerDown('mouse');
    mouseUp();

    act(() => hook().commitPendingSelection());
    expect(hook().selection?.text).toBe('MOUSE-B');
  });

  it('a mouse selection that collapses also drops the pending pill', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-A' });
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection?.text).toBe('TOUCH-A');

    mockResolve.mockReturnValue(null);
    pointerDown('mouse');
    mouseUp();
    expect(hook().selection).toBeNull();
    expect(hook().pendingSelection).toBeNull();
  });

  // Tapping the pill collapses the native selection. If the debounce then
  // resolves null it drops the pending selection and the commit that follows
  // finds nothing, so the tap silently does nothing. Guarded on where the
  // gesture started rather than on winning a race against the timer.
  it('a gesture starting inside the pill does not clear the pending selection', () => {
    mockResolve.mockReturnValue(INFO);
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection).toEqual(INFO);

    // The pill carries data-preserve-selection.
    const pillEl = document.createElement('div');
    pillEl.setAttribute('data-preserve-selection', '');
    document.body.appendChild(pillEl);
    const e = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    Object.defineProperty(e, 'target', { value: pillEl });
    act(() => {
      document.dispatchEvent(e);
    });

    // The tap collapsed the selection.
    mockResolve.mockReturnValue(null);
    selectionChange();

    expect(hook().pendingSelection).toEqual(INFO);
    act(() => hook().commitPendingSelection());
    expect(hook().selection).toEqual(INFO);
    pillEl.remove();
  });

  it('a commit landing inside the debounce window does not resurrect pending', () => {
    mockResolve.mockReturnValue(INFO);
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection).toEqual(INFO);

    // The tap collapses the selection, which schedules a second timer while
    // nothing is committed yet, so the pre-check does not bail.
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Then the click lands and commits.
    act(() => {
      hook().commitPendingSelection();
    });
    expect(hook().selection).toEqual(INFO);

    // That in-flight timer must not write pendingSelection back.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hook().pendingSelection).toBeNull();
    expect(hook().selection).toEqual(INFO);
  });

  // A debounce timer must only ever apply to the gesture that armed it. Without
  // that, a touch selectionchange could arm a timer, a mouse drag could commit
  // inside the 150ms window, and the stale timer would then destroy the fresh
  // mouse selection.
  it('a stale timer cannot destroy a selection committed after it was armed', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'MOUSE-A' });
    pointerDown('mouse');
    mouseUp();

    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-B' });
    pointerDown('touch');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });

    mockResolve.mockReturnValue({ ...INFO, text: 'MOUSE-C' });
    pointerDown('mouse');
    mouseUp();
    expect(hook().selection?.text).toBe('MOUSE-C');

    mockResolve.mockReturnValue(null);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hook().selection?.text).toBe('MOUSE-C');
    expect(hook().pendingSelection).toBeNull();
  });

  // The preserved-target guard exists to stop the tap that engages the pill from
  // erasing pending when it collapses the selection. It must not veto a real
  // adjustment: native handle drags emit no pointerdown, so the flag survives
  // that tap indefinitely.
  it('handle adjustments still land after a tap on a preserved element', () => {
    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-A' });
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection?.text).toBe('TOUCH-A');

    const el = document.createElement('span');
    el.setAttribute('data-preserve-selection', '');
    document.body.appendChild(el);
    const e = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    Object.defineProperty(e, 'target', { value: el });
    act(() => {
      document.dispatchEvent(e);
    });

    mockResolve.mockReturnValue({ ...INFO, text: 'TOUCH-A-WIDER' });
    selectionChange();
    expect(hook().pendingSelection?.text).toBe('TOUCH-A-WIDER');

    // But a collapse right after that tap still leaves pending intact.
    mockResolve.mockReturnValue(null);
    const e2 = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(e2, 'pointerType', { value: 'touch' });
    Object.defineProperty(e2, 'target', { value: el });
    act(() => {
      document.dispatchEvent(e2);
    });
    selectionChange();
    expect(hook().pendingSelection?.text).toBe('TOUCH-A-WIDER');
    el.remove();
  });

  it('does not capture pending while locked', () => {
    act(() => hook().lockSelection());
    pointerDown('touch');
    selectionChange();
    expect(hook().pendingSelection).toBeNull();
  });

  it('debounces the selectionchange stream during handle drags', () => {
    pointerDown('touch');
    act(() => {
      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new Event('selectionchange'));
        vi.advanceTimersByTime(50);
      }
    });
    expect(mockResolve).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });
});
