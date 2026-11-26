// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { useElementNarrowerThan } from './useElementNarrowerThan';

// jsdom has neither layout nor ResizeObserver. The stub records each observer
// so a test can fire a resize and check that unmount disconnects it.
let observers: ResizeObserverStub[] = [];
class ResizeObserverStub {
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  connected = true;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.connected = false;
  }
  fire() {
    if (this.connected) this.callback([], this as unknown as ResizeObserver);
  }
}

let rectWidth = 0;
let seen: boolean[] = [];

function Probe({ attach = true }: { attach?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useElementNarrowerThan(ref, 600);
  seen.push(narrow);
  return (
    <div ref={attach ? ref : undefined} data-testid="probe">
      {String(narrow)}
    </div>
  );
}

beforeEach(() => {
  observers = [];
  seen = [];
  rectWidth = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: rectWidth }) as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useElementNarrowerThan', () => {
  it('reads false on the first render, before any measurement', () => {
    rectWidth = 480;
    render(<Probe />);
    expect(seen[0]).toBe(false);
  });

  it('measures the element on mount and observes it', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('true');
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([getByTestId('probe')]);
  });

  it('treats the threshold itself as wide', () => {
    rectWidth = 600;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('false');
  });

  it('updates when the observer reports a resize across the threshold', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    rectWidth = 720;
    act(() => observers[0].fire());
    expect(getByTestId('probe').textContent).toBe('false');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(observers[0].connected).toBe(true);
    unmount();
    expect(observers[0].connected).toBe(false);
  });

  it('stays false when the ref is never attached', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe attach={false} />);
    expect(getByTestId('probe').textContent).toBe('false');
    expect(observers).toHaveLength(0);
  });

  it('stays false where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('false');
  });

  it('treats a width of 0 as not measured, not narrow', () => {
    rectWidth = 0;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('false');
  });
});
