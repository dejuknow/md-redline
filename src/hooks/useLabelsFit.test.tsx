// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';
import { useLabelsFit } from './useLabelsFit';

// jsdom does no layout, so the row, its buttons and its close button report
// the widths set here. Two 80px labeled buttons need 160px; the close button
// takes 22px of the row.
let rowWidth = 200;
let observers: Array<() => void> = [];

class ResizeObserverStub {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe() {
    observers.push(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((cb) => cb !== this.cb);
  }
}

function rect(left: number, width: number): DOMRect {
  return {
    left,
    width,
    right: left + width,
    x: left,
    y: 0,
    top: 0,
    bottom: 20,
    height: 20,
  } as DOMRect;
}

function Row() {
  const group = useRef<HTMLDivElement>(null);
  const [fits, rowRef] = useLabelsFit(group);
  return (
    <div ref={rowRef} data-testid="row" data-fits={String(fits)}>
      <div ref={group} data-testid="group">
        <button data-left="0">Explorer</button>
        <button data-left="80">Outline</button>
      </div>
      <button data-testid="close">x</button>
    </div>
  );
}

function resizeRow(width: number) {
  rowWidth = width;
  act(() => observers.forEach((cb) => cb()));
}

describe('useLabelsFit', () => {
  beforeEach(() => {
    rowWidth = 200;
    observers = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.getAttribute('data-testid') === 'row') return rect(0, rowWidth);
      if (this.getAttribute('data-testid') === 'close') return rect(rowWidth - 22, 22);
      const left = this.getAttribute('data-left');
      if (left !== null) return rect(Number(left), 80);
      return rect(0, 0);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const fits = (el: HTMLElement) =>
    el.querySelector('[data-testid="row"]')!.getAttribute('data-fits');

  it('keeps the labels when the row has room for them', () => {
    const { container } = render(<Row />);
    expect(fits(container)).toBe('true');
  });

  it('drops the labels when the row is too narrow, and brings them back when it widens', () => {
    const { container } = render(<Row />);
    resizeRow(170);
    expect(fits(container)).toBe('false');
    resizeRow(182);
    expect(fits(container)).toBe('true');
  });

  it('settles at the edge even when the group claims to overflow', () => {
    // The desktop app's zoomed WKWebView reported overflow (scrollWidth past
    // clientWidth) for a row whose measured room fit the labels. Deciding one
    // direction from each number flipped the labels forever and React blanked
    // the window. The room alone decides now.
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(150);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<Row />);
    for (const width of [181.6, 181.4, 181.5, 170, 181.6]) resizeRow(width);
    expect(fits(container)).toBe('true');
    expect(errors).not.toHaveBeenCalled();
  });
});
