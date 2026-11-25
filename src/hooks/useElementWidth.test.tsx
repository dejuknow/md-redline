// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { useElementWidth } from './useElementWidth';

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
let seen: number[] = [];

function Probe({ attach = true }: { attach?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  seen.push(width);
  return (
    <div ref={attach ? ref : undefined} data-testid="probe">
      {width}
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

describe('useElementWidth', () => {
  it('reads 0 on the first render, before any measurement', () => {
    rectWidth = 480;
    render(<Probe />);
    expect(seen[0]).toBe(0);
  });

  it('measures the element on mount and observes it', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('480');
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([getByTestId('probe')]);
  });

  it('updates when the observer reports a resize', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    rectWidth = 720;
    act(() => observers[0].fire());
    expect(getByTestId('probe').textContent).toBe('720');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(observers[0].connected).toBe(true);
    unmount();
    expect(observers[0].connected).toBe(false);
  });

  it('stays 0 when the ref is never attached', () => {
    rectWidth = 480;
    const { getByTestId } = render(<Probe attach={false} />);
    expect(getByTestId('probe').textContent).toBe('0');
    expect(observers).toHaveLength(0);
  });

  it('stays 0 where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    rectWidth = 480;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('0');
  });
});
