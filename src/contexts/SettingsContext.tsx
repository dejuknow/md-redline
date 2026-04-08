import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  type AppSettings,
  type CommentTemplate,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  parseSettings,
} from '../lib/settings';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

interface SettingsContextValue {
  settings: AppSettings;
  updateTemplates: (templates: CommentTemplate[]) => void;
  updateCommentMaxLength: (maxLength: number) => void;
  updateShowTemplatesByDefault: (show: boolean) => void;
  updateEnableResolve: (enable: boolean) => void;
  updateQuickComment: (quick: boolean) => void;
  resetTemplates: () => void;
  resetAll: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function persist(settings: AppSettings) {
  void savePreferencesToDisk({
    settings: settings as unknown as Record<string, unknown>,
  });
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const hasLocalMutationRef = useRef(false);

  // Hydrate from disk on mount. Disk is the source of truth.
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled || hasLocalMutationRef.current) return;
      if (prefs.settings && typeof prefs.settings === 'object') {
        setSettings(parseSettings(prefs.settings));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    hasLocalMutationRef.current = true;
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, []);

  const updateTemplates = useCallback(
    (templates: CommentTemplate[]) => update({ templates }),
    [update],
  );

  const updateCommentMaxLength = useCallback(
    (commentMaxLength: number) => update({ commentMaxLength }),
    [update],
  );

  const updateShowTemplatesByDefault = useCallback(
    (showTemplatesByDefault: boolean) => update({ showTemplatesByDefault }),
    [update],
  );

  const updateEnableResolve = useCallback(
    (enableResolve: boolean) => update({ enableResolve }),
    [update],
  );

  const updateQuickComment = useCallback(
    (quickComment: boolean) => update({ quickComment }),
    [update],
  );

  const resetTemplates = useCallback(() => update({ templates: DEFAULT_TEMPLATES }), [update]);

  const resetAll = useCallback(() => {
    hasLocalMutationRef.current = true;
    setSettings(DEFAULT_SETTINGS);
    persist(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateTemplates,
        updateCommentMaxLength,
        updateShowTemplatesByDefault,
        updateEnableResolve,
        updateQuickComment,
        resetTemplates,
        resetAll,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
