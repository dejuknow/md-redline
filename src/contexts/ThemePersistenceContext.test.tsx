// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setThemeNextThemes = vi.fn();
const fetchPreferences = vi.fn();
const savePreferencesToDisk = vi.fn();
let currentTheme = 'system';

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: currentTheme,
    setTheme: setThemeNextThemes,
  }),
}));

vi.mock('../lib/preferences-client', () => ({
  fetchPreferences: (...args: unknown[]) => fetchPreferences(...args),
  savePreferencesToDisk: (...args: unknown[]) => savePreferencesToDisk(...args),
}));

import {
  resetThemePersistenceStateForTests,
  ThemePersistenceProvider,
  useThemePersistence,
} from './ThemePersistenceContext';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ThemePersistenceProvider, null, children);
}

describe('ThemePersistenceContext', () => {
  beforeEach(() => {
    currentTheme = 'system';
    setThemeNextThemes.mockReset();
    fetchPreferences.mockReset();
    savePreferencesToDisk.mockReset();
    fetchPreferences.mockResolvedValue({});
    resetThemePersistenceStateForTests();
  });

  it('hydrates preferences only once across multiple hook instances', async () => {
    fetchPreferences.mockResolvedValue({ theme: 'dark' });

    renderHook(() => useThemePersistence(), { wrapper });
    renderHook(() => useThemePersistence(), { wrapper });

    await waitFor(() => {
      expect(fetchPreferences).toHaveBeenCalledTimes(1);
    });
    expect(setThemeNextThemes).toHaveBeenCalledWith('dark');
  });

  it('defaults to system when no persisted theme exists', async () => {
    const { result } = renderHook(() => useThemePersistence(), { wrapper });

    await waitFor(() => {
      expect(fetchPreferences).toHaveBeenCalledTimes(1);
    });

    expect(result.current.theme).toBe('system');
    expect(setThemeNextThemes).not.toHaveBeenCalled();
  });

  it('does not save or set theme when selecting the already active theme', () => {
    currentTheme = 'dark';
    const { result } = renderHook(() => useThemePersistence(), { wrapper });

    result.current.setTheme('dark');

    expect(setThemeNextThemes).not.toHaveBeenCalled();
    expect(savePreferencesToDisk).not.toHaveBeenCalled();
  });
});
