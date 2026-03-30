import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchPreferences, savePreferencesToDisk, migrateLocalStorageToDisk } from './preferences-client';

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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe('fetchPreferences', () => {
  it('returns parsed JSON on successful response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ author: 'Alice', theme: 'dark' }),
    });
    const result = await fetchPreferences();
    expect(result).toEqual({ author: 'Alice', theme: 'dark' });
  });

  it('returns empty object when response is not ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchPreferences();
    expect(result).toEqual({});
  });

  it('returns empty object on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const result = await fetchPreferences();
    expect(result).toEqual({});
  });
});

describe('savePreferencesToDisk', () => {
  it('sends PUT request with correct body', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await savePreferencesToDisk({ author: 'Bob' });
    expect(mockFetch).toHaveBeenCalledWith('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'Bob' }),
    });
  });

  it('does not throw on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    await expect(savePreferencesToDisk({ author: 'Bob' })).resolves.toBeUndefined();
  });

  it('does not throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(savePreferencesToDisk({ author: 'Bob' })).resolves.toBeUndefined();
  });
});

describe('migrateLocalStorageToDisk', () => {
  it('skips migration when already migrated', async () => {
    store['md-redline-migrated-to-disk'] = '1';
    await migrateLocalStorageToDisk();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips migration when disk has existing data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ author: 'Existing' }),
    });
    await migrateLocalStorageToDisk();
    expect(store['md-redline-migrated-to-disk']).toBe('1');
    // Should not have called PUT
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only the GET
  });

  it('migrates author, settings, theme, recentFiles from localStorage', async () => {
    // Mock disk as empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    // Mock save
    mockFetch.mockResolvedValueOnce({ ok: true });

    store['md-redline-author'] = 'Alice';
    store['md-redline-settings'] = JSON.stringify({ enableResolve: true });
    store['theme'] = 'dark';
    store['md-redline-recent-files'] = JSON.stringify([{ path: '/test.md', name: 'test.md', openedAt: '2026-01-01' }]);

    await migrateLocalStorageToDisk();

    // Verify PUT was called with migrated data
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const putCall = mockFetch.mock.calls[1];
    expect(putCall[0]).toBe('/api/preferences');
    const body = JSON.parse(putCall[1].body);
    expect(body.author).toBe('Alice');
    expect(body.settings).toEqual({ enableResolve: true });
    expect(body.theme).toBe('dark');
    expect(body.recentFiles).toHaveLength(1);
  });

  it('removes migrated keys from localStorage except theme', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    store['md-redline-author'] = 'Alice';
    store['theme'] = 'dark';

    await migrateLocalStorageToDisk();

    expect(localStorageMock.removeItem).toHaveBeenCalledWith('md-redline-author');
    // Theme should NOT be removed (next-themes reads it synchronously)
    expect(localStorageMock.removeItem).not.toHaveBeenCalledWith('theme');
  });

  it('sets migrated flag after successful migration', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await migrateLocalStorageToDisk();
    expect(store['md-redline-migrated-to-disk']).toBe('1');
  });
});
