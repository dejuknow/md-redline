// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();

vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

import { SettingsProvider, useSettings } from './SettingsContext';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(SettingsProvider, null, children);
}

describe('SettingsContext hydrate race', () => {
  beforeEach(() => {
    fetchPreferences.mockReset();
    savePreferencesToDisk.mockReset();
  });

  it('does not clobber on-disk settings when the user mutates before hydrate completes', async () => {
    // Disk has a custom template the user previously saved.
    let resolveFetch: (value: unknown) => void;
    fetchPreferences.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = res;
        }),
    );

    const { result } = renderHook(() => useSettings(), { wrapper });

    // Hydration is in flight. Mutate locally before it completes.
    act(() => {
      result.current.updateQuickComment(true);
    });

    // No persist should fire yet — the disk read isn't done. If we
    // persisted now, we'd write defaults+toggle and lose the disk
    // template.
    expect(savePreferencesToDisk).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(false);

    // Disk reply arrives.
    act(() => {
      resolveFetch!({
        settings: {
          templates: [{ label: 'Saved', text: 'from disk' }],
          quickComment: false,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true);
    });

    // Final state must include BOTH the disk template AND the
    // pre-hydrate user toggle.
    expect(result.current.settings.templates).toEqual([
      { label: 'Saved', text: 'from disk' },
    ]);
    expect(result.current.settings.quickComment).toBe(true);

    // And exactly one persist should have fired (the post-hydrate replay)
    // carrying the merged shape.
    expect(savePreferencesToDisk).toHaveBeenCalledTimes(1);
    const persistedArg = savePreferencesToDisk.mock.calls[0][0] as {
      settings: { templates: unknown; quickComment: boolean };
    };
    expect(persistedArg.settings.quickComment).toBe(true);
    expect(persistedArg.settings.templates).toEqual([
      { label: 'Saved', text: 'from disk' },
    ]);
  });

  it('persists immediately on mutations made after hydrate completes', async () => {
    fetchPreferences.mockResolvedValue({ settings: { quickComment: false } });
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true);
    });

    expect(savePreferencesToDisk).not.toHaveBeenCalled();

    act(() => {
      result.current.updateQuickComment(true);
    });

    expect(savePreferencesToDisk).toHaveBeenCalledTimes(1);
    expect(result.current.settings.quickComment).toBe(true);
  });

  it('hydrates from disk when there are no pre-hydrate mutations', async () => {
    fetchPreferences.mockResolvedValue({
      settings: {
        templates: [{ label: 'A', text: 'a' }],
        commentMaxLength: 1234,
      },
    });
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true);
    });

    expect(result.current.settings.commentMaxLength).toBe(1234);
    expect(result.current.settings.templates).toEqual([{ label: 'A', text: 'a' }]);
    // No mutation happened, so no replay-persist either.
    expect(savePreferencesToDisk).not.toHaveBeenCalled();
  });
});
