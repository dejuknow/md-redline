// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { usePageVisible } from './usePageVisible';

let root: Root;
let container: HTMLDivElement;

function TestComponent() {
  return createElement('div', undefined, usePageVisible() ? 'visible' : 'hidden');
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    writable: true,
    configurable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
});

describe('usePageVisible', () => {
  it('returns true when the page is visible', () => {
    act(() => root.render(createElement(TestComponent)));
    expect(container.textContent).toBe('visible');
  });

  it('returns false after the page becomes hidden', () => {
    act(() => root.render(createElement(TestComponent)));
    setVisibility('hidden');
    expect(container.textContent).toBe('hidden');
  });

  it('returns true again when the page becomes visible', () => {
    act(() => root.render(createElement(TestComponent)));
    setVisibility('hidden');
    expect(container.textContent).toBe('hidden');
    setVisibility('visible');
    expect(container.textContent).toBe('visible');
  });

  it('cleans up the event listener on unmount', () => {
    act(() => root.render(createElement(TestComponent)));
    const spy = vi.spyOn(document, 'removeEventListener');
    act(() => root.unmount());
    expect(spy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    spy.mockRestore();
  });
});
