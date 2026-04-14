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
  const setThemeRef = useRef(setThemeNextThemes);
  setThemeRef.current = setThemeNextThemes;

  // Load server-persisted theme on mount. Runs once — subsequent changes are
  // handled by setThemePersistent below, not by this effect. Using a ref for
  // setTheme prevents re-runs when next-themes gives a new function reference
  // on theme change, which caused cross-tab ping-pong: tab A changes theme →
  // localStorage sync → tab B re-renders → effect re-fires with stale cached
  // prefs → bounces theme back → tab A detects → flicker loop.
  useEffect(() => {
    let cancelled = false;
    const versionAtMount = themeWriteVersion;

    loadPreferencesOnce().then((prefs) => {
      if (cancelled || versionAtMount !== themeWriteVersion) return;
      if (prefs.theme && prefs.theme !== themeRef.current) {
        setThemeRef.current(prefs.theme);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
