// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const save = vi.fn<(patch: unknown) => Promise<boolean>>(() => Promise.resolve(true));
vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: () => new Promise(() => {}),
  savePreferencesToDisk: (patch: unknown) => save(patch),
}));

import { useRecentFiles } from './useRecentFiles';

describe('useRecentFiles', () => {
  beforeEach(() => save.mockClear());

  it('adds a batch in one update and one save, the first one newest', () => {
    const { result } = renderHook(() => useRecentFiles());
    act(() => result.current.addRecentFile('/docs/c.md'));
    save.mockClear();
    act(() => result.current.addRecentFiles(['/docs/a.md', '/docs/b.md', '/docs/c.md']));
    expect(result.current.recentFiles.map((f) => f.path)).toEqual([
      '/docs/a.md',
      '/docs/b.md',
      '/docs/c.md',
    ]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ recentFiles: result.current.recentFiles });
  });

  it('ignores an empty batch', () => {
    const { result } = renderHook(() => useRecentFiles());
    act(() => result.current.addRecentFiles([]));
    expect(result.current.recentFiles).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});
