import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useTheme } from 'next-themes';
import {
  fetchPreferences,
  savePreferencesToDisk,
  type DiskPreferences,
} from '../lib/preferences-client';

const ThemeValueContext = createContext<string | undefined>(undefined);
const ThemeSetterContext = createContext<((newTheme: string) => void) | null>(null);

let cachedPreferences: DiskPreferences | null = null;
let preferencesPromise: Promise<DiskPreferences> | null = null;
let themeWriteVersion = 0;

function loadPreferencesOnce(): Promise<DiskPreferences> {
  if (cachedPreferences) {
    return Promise.resolve(cachedPreferences);
  }

  if (!preferencesPromise) {
    preferencesPromise = fetchPreferences().then((prefs) => {
      cachedPreferences = prefs;
      return prefs;
    });
  }

  return preferencesPromise;
}

export function resetThemePersistenceStateForTests() {
  cachedPreferences = null;
  preferencesPromise = null;
  themeWriteVersion = 0;
}

export function ThemePersistenceProvider({ children }: { children: ReactNode }) {
  const { theme, setTheme: setThemeNextThemes } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    let cancelled = false;
    const versionAtMount = themeWriteVersion;

    loadPreferencesOnce().then((prefs) => {
      if (cancelled || versionAtMount !== themeWriteVersion) return;
      if (prefs.theme && prefs.theme !== themeRef.current) {
        setThemeNextThemes(prefs.theme);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [setThemeNextThemes]);

  const setThemePersistent = useCallback(
    (newTheme: string) => {
      if (newTheme === themeRef.current) return;

      themeWriteVersion += 1;
      cachedPreferences = { ...(cachedPreferences ?? {}), theme: newTheme };
      setThemeNextThemes(newTheme);
      void savePreferencesToDisk({ theme: newTheme });
    },
    [setThemeNextThemes],
  );

  return (
    <ThemeSetterContext.Provider value={setThemePersistent}>
      <ThemeValueContext.Provider value={theme}>{children}</ThemeValueContext.Provider>
    </ThemeSetterContext.Provider>
  );
}

export function usePersistedTheme() {
  return useContext(ThemeValueContext);
}

export function useSetPersistedTheme() {
  const setTheme = useContext(ThemeSetterContext);
  if (!setTheme) {
    throw new Error('useSetPersistedTheme must be used within ThemePersistenceProvider');
  }
  return setTheme;
}

export function useThemePersistence() {
  return {
    theme: usePersistedTheme(),
    setTheme: useSetPersistedTheme(),
  };
}
