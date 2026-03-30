import { describe, it, expect, beforeEach, vi } from 'vitest';
import { load, save } from './usePaneLayout';

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const key in store) delete store[key]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const DEFAULTS = {
  explorerVisible: true,
  sidebarVisible: true,
  leftPanelView: 'explorer' as const,
  viewMode: 'rendered' as const,
};

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe('load', () => {
  it('returns defaults when localStorage is empty', () => {
    expect(load()).toEqual(DEFAULTS);
  });

  it('returns defaults on invalid JSON', () => {
    store['md-redline-pane-layout'] = 'not-json!!!';
    expect(load()).toEqual(DEFAULTS);
  });

  it('preserves valid boolean explorerVisible', () => {
    store['md-redline-pane-layout'] = JSON.stringify({ explorerVisible: false });
    expect(load().explorerVisible).toBe(false);
  });

  it('falls back to default for non-boolean explorerVisible', () => {
    store['md-redline-pane-layout'] = JSON.stringify({ explorerVisible: 'yes' });
    expect(load().explorerVisible).toBe(true);
  });

  it('preserves valid boolean sidebarVisible', () => {
    store['md-redline-pane-layout'] = JSON.stringify({ sidebarVisible: false });
    expect(load().sidebarVisible).toBe(false);
  });

  it('only accepts "outline" or "explorer" for leftPanelView', () => {
    store['md-redline-pane-layout'] = JSON.stringify({ leftPanelView: 'outline' });
    expect(load().leftPanelView).toBe('outline');

    store['md-redline-pane-layout'] = JSON.stringify({ leftPanelView: 'invalid' });
    expect(load().leftPanelView).toBe('explorer');
  });

  it('only accepts valid viewMode values', () => {
    for (const mode of ['rendered', 'raw', 'diff']) {
      store['md-redline-pane-layout'] = JSON.stringify({ viewMode: mode });
      expect(load().viewMode).toBe(mode);
    }

    store['md-redline-pane-layout'] = JSON.stringify({ viewMode: 'invalid' });
    expect(load().viewMode).toBe('rendered');
  });
});

describe('save', () => {
  it('persists layout to localStorage', () => {
    const layout = { explorerVisible: false, sidebarVisible: true, leftPanelView: 'outline' as const, viewMode: 'raw' as const };
    save(layout);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('md-redline-pane-layout', JSON.stringify(layout));
  });

  it('round-trips through load', () => {
    const layout = { explorerVisible: false, sidebarVisible: false, leftPanelView: 'outline' as const, viewMode: 'diff' as const };
    save(layout);
    expect(load()).toEqual(layout);
  });
});
