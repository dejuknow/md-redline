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

  it('stops capturing pending while a selection is committed', () => {
    pointerDown('touch');
    selectionChange();
    act(() => hook().commitPendingSelection());
    mockResolve.mockReturnValue({ ...INFO, text: 'other' });
    selectionChange();
    expect(hook().pendingSelection).toBeNull();
    expect(hook().selection).toEqual(INFO);
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
