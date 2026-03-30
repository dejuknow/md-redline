import { useEffect, useCallback, useRef } from 'react';
import { useTheme } from 'next-themes';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

/**
 * Syncs theme selection to disk. On mount, hydrates from disk preferences.
 * Returns a wrapped setTheme that writes to both next-themes (localStorage) and disk.
 */
export function useThemePersistence() {
  const { theme, setTheme: setThemeNextThemes } = useTheme();
  const hasLocalMutationRef = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Hydrate from disk on mount
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled || hasLocalMutationRef.current) return;
      if (prefs.theme && prefs.theme !== themeRef.current) {
        setThemeNextThemes(prefs.theme);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wrapped setTheme that dual-writes
  const setTheme = useCallback(
    (newTheme: string) => {
      hasLocalMutationRef.current = true;
      setThemeNextThemes(newTheme);
      savePreferencesToDisk({ theme: newTheme });
    },
    [setThemeNextThemes],
  );

  return { theme, setTheme };
}
