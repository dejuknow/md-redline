import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSession } from './useSessionPersistence';

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

describe('loadSession', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadSession()).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    store['md-redline-session'] = 'not-json!!!';
    expect(loadSession()).toBeNull();
  });

  it('returns null when openTabs is not an array', () => {
    store['md-redline-session'] = JSON.stringify({ openTabs: 'not-array' });
    expect(loadSession()).toBeNull();
  });

  it('returns null when openTabs is missing', () => {
    store['md-redline-session'] = JSON.stringify({ activeFilePath: '/test.md' });
    expect(loadSession()).toBeNull();
  });

  it('returns parsed session when valid', () => {
    const session = { openTabs: ['/a.md', '/b.md'], activeFilePath: '/a.md' };
    store['md-redline-session'] = JSON.stringify(session);
    expect(loadSession()).toEqual(session);
  });

  it('returns session with empty openTabs array', () => {
    const session = { openTabs: [], activeFilePath: null };
    store['md-redline-session'] = JSON.stringify(session);
    expect(loadSession()).toEqual(session);
  });
});
