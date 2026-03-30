import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock preferences-client before importing module under test
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: vi.fn(() => Promise.resolve({})),
  savePreferencesToDisk: vi.fn(() => Promise.resolve()),
}));

import { loadFromStorage, mergeRecentFiles, saveToStorage } from './useRecentFiles';
import { savePreferencesToDisk } from '../lib/preferences-client';

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

describe('loadFromStorage', () => {
  it('returns empty array when localStorage is empty', () => {
    expect(loadFromStorage()).toEqual([]);
  });

  it('returns empty array on invalid JSON', () => {
    store['md-redline-recent-files'] = 'bad-json';
    expect(loadFromStorage()).toEqual([]);
  });

  it('returns parsed array when valid', () => {
    const files = [{ path: '/a.md', name: 'a.md', openedAt: '2026-01-01T00:00:00.000Z' }];
    store['md-redline-recent-files'] = JSON.stringify(files);
    expect(loadFromStorage()).toEqual(files);
  });
});

describe('saveToStorage', () => {
  it('persists files to localStorage as JSON', () => {
    const files = [{ path: '/b.md', name: 'b.md', openedAt: '2026-01-01T00:00:00.000Z' }];
    saveToStorage(files);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'md-redline-recent-files',
      JSON.stringify(files),
    );
  });

  it('calls savePreferencesToDisk with the files', () => {
    const files = [{ path: '/c.md', name: 'c.md', openedAt: '2026-01-01T00:00:00.000Z' }];
    saveToStorage(files);
    expect(savePreferencesToDisk).toHaveBeenCalledWith({ recentFiles: files });
  });

  it('round-trips through loadFromStorage', () => {
    const files = [
      { path: '/d.md', name: 'd.md', openedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/e.md', name: 'e.md', openedAt: '2026-01-02T00:00:00.000Z' },
    ];
    saveToStorage(files);
    expect(loadFromStorage()).toEqual(files);
  });
});

describe('mergeRecentFiles', () => {
  it('merges and sorts recents by most recent openedAt', () => {
    const merged = mergeRecentFiles(
      [{ path: '/a.md', name: 'a.md', openedAt: '2026-01-01T00:00:00.000Z' }],
      [{ path: '/b.md', name: 'b.md', openedAt: '2026-01-02T00:00:00.000Z' }],
    );

    expect(merged.map((file) => file.path)).toEqual(['/b.md', '/a.md']);
  });

  it('keeps the newest timestamp when the same file exists in both sources', () => {
    const merged = mergeRecentFiles(
      [{ path: '/a.md', name: 'a.md', openedAt: '2026-01-03T00:00:00.000Z' }],
      [
        { path: '/a.md', name: 'a.md', openedAt: '2026-01-01T00:00:00.000Z' },
        { path: '/b.md', name: 'b.md', openedAt: '2026-01-02T00:00:00.000Z' },
      ],
    );

    expect(merged).toEqual([
      { path: '/a.md', name: 'a.md', openedAt: '2026-01-03T00:00:00.000Z' },
      { path: '/b.md', name: 'b.md', openedAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });
});
