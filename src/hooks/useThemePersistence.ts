import { useEffect, useCallback } from 'react';
import { useTheme } from 'next-themes';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

/**
 * Syncs theme selection to disk. On mount, hydrates from disk preferences.
 * Returns a wrapped setTheme that writes to both next-themes (localStorage) and disk.
 */
export function useThemePersistence() {
  const { theme, setTheme: setThemeNextThemes } = useTheme();

  // Hydrate from disk on mount
  useEffect(() => {
    fetchPreferences().then((prefs) => {
      if (prefs.theme && prefs.theme !== theme) {
        setThemeNextThemes(prefs.theme);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wrapped setTheme that dual-writes
  const setTheme = useCallback(
    (newTheme: string) => {
      setThemeNextThemes(newTheme);
      savePreferencesToDisk({ theme: newTheme });
    },
    [setThemeNextThemes],
  );

  return { theme, setTheme };
}
