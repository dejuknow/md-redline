import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, DEFAULT_TEMPLATES } from './settings';

// Mock localStorage
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

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored value is invalid JSON', () => {
    store['md-redline-settings'] = 'not-json!!!';
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for empty object', () => {
    store['md-redline-settings'] = '{}';
    const result = loadSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('preserves valid enableResolve value', () => {
    store['md-redline-settings'] = JSON.stringify({ enableResolve: true });
    expect(loadSettings().enableResolve).toBe(true);
  });

  it('falls back to default when enableResolve is not a boolean', () => {
    store['md-redline-settings'] = JSON.stringify({ enableResolve: 'yes' });
    expect(loadSettings().enableResolve).toBe(false);
  });

  it('preserves valid quickComment value', () => {
    store['md-redline-settings'] = JSON.stringify({ quickComment: true });
    expect(loadSettings().quickComment).toBe(true);
  });

  it('falls back to default when quickComment is not a boolean', () => {
    store['md-redline-settings'] = JSON.stringify({ quickComment: 42 });
    expect(loadSettings().quickComment).toBe(false);
  });

  it('preserves valid showTemplatesByDefault value', () => {
    store['md-redline-settings'] = JSON.stringify({ showTemplatesByDefault: true });
    expect(loadSettings().showTemplatesByDefault).toBe(true);
  });

  it('falls back to default when showTemplatesByDefault is not a boolean', () => {
    store['md-redline-settings'] = JSON.stringify({ showTemplatesByDefault: null });
    expect(loadSettings().showTemplatesByDefault).toBe(false);
  });

  it('preserves valid commentMaxLength', () => {
    store['md-redline-settings'] = JSON.stringify({ commentMaxLength: 1000 });
    expect(loadSettings().commentMaxLength).toBe(1000);
  });

  it('falls back to default for zero commentMaxLength', () => {
    store['md-redline-settings'] = JSON.stringify({ commentMaxLength: 0 });
    expect(loadSettings().commentMaxLength).toBe(1000);
  });

  it('falls back to default for negative commentMaxLength', () => {
    store['md-redline-settings'] = JSON.stringify({ commentMaxLength: -10 });
    expect(loadSettings().commentMaxLength).toBe(1000);
  });

  it('falls back to default for non-numeric commentMaxLength', () => {
    store['md-redline-settings'] = JSON.stringify({ commentMaxLength: 'big' });
    expect(loadSettings().commentMaxLength).toBe(1000);
  });

  it('preserves valid templates array', () => {
    const templates = [{ label: 'Custom', text: 'Custom text' }];
    store['md-redline-settings'] = JSON.stringify({ templates });
    expect(loadSettings().templates).toEqual(templates);
  });

  it('falls back to default templates when templates is not an array', () => {
    store['md-redline-settings'] = JSON.stringify({ templates: 'not-an-array' });
    expect(loadSettings().templates).toEqual(DEFAULT_TEMPLATES);
  });

  it('handles missing new fields gracefully (migration from older version)', () => {
    // Simulate stored settings from before enableResolve and quickComment existed
    store['md-redline-settings'] = JSON.stringify({
      templates: DEFAULT_TEMPLATES,
      commentMaxLength: 1000,
      showTemplatesByDefault: false,
    });
    const result = loadSettings();
    expect(result.enableResolve).toBe(false);
    expect(result.quickComment).toBe(false);
    expect(result.commentMaxLength).toBe(1000);
    expect(result.showTemplatesByDefault).toBe(false);
  });

  it('preserves a full valid settings object', () => {
    const full = {
      templates: [{ label: 'A', text: 'B' }],
      commentMaxLength: 750,
      showTemplatesByDefault: true,
      enableResolve: true,
      quickComment: true,
    };
    store['md-redline-settings'] = JSON.stringify(full);
    expect(loadSettings()).toEqual(full);
  });
});

describe('saveSettings', () => {
  it('persists settings to localStorage', () => {
    saveSettings(DEFAULT_SETTINGS);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'md-redline-settings',
      JSON.stringify(DEFAULT_SETTINGS),
    );
  });

  it('round-trips through load', () => {
    const custom = { ...DEFAULT_SETTINGS, enableResolve: true, quickComment: true, commentMaxLength: 999 };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });
});
