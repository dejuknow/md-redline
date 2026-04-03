import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clamp, loadWidths } from './useResizablePanel';

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
  clear: vi.fn(() => {
    for (const key in store) delete store[key];
  }),
  get length() {
    return Object.keys(store).length;
  },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns min when value is below range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('returns max when value is above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles equal min and max', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });

  it('returns boundary values exactly', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('loadWidths', () => {
  const DEFAULTS = { explorer: 224, sidebar: 320 };

  it('returns defaults when localStorage is empty', () => {
    expect(loadWidths()).toEqual(DEFAULTS);
  });

  it('returns defaults on invalid JSON', () => {
    store['md-redline-panel-widths'] = 'bad-json';
    expect(loadWidths()).toEqual(DEFAULTS);
  });

  it('clamps explorer width to bounds', () => {
    store['md-redline-panel-widths'] = JSON.stringify({ explorer: 50, sidebar: 320 });
    const result = loadWidths();
    expect(result.explorer).toBe(160); // MIN_WIDTHS.explorer
  });

  it('clamps sidebar width to bounds', () => {
    store['md-redline-panel-widths'] = JSON.stringify({ explorer: 224, sidebar: 999 });
    const result = loadWidths();
    expect(result.sidebar).toBe(560); // MAX_WIDTHS.sidebar
  });

  it('preserves valid widths', () => {
    store['md-redline-panel-widths'] = JSON.stringify({ explorer: 300, sidebar: 400 });
    expect(loadWidths()).toEqual({ explorer: 300, sidebar: 400 });
  });

  it('handles missing fields gracefully', () => {
    store['md-redline-panel-widths'] = JSON.stringify({});
    expect(loadWidths()).toEqual(DEFAULTS);
  });
});
