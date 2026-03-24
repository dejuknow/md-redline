import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import {
  type AppSettings,
  type CommentTemplate,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  loadSettings,
  saveSettings,
} from '../lib/settings';

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

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
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

  const resetTemplates = useCallback(
    () => update({ templates: DEFAULT_TEMPLATES }),
    [update],
  );

  const resetAll = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider
      value={{ settings, updateTemplates, updateCommentMaxLength, updateShowTemplatesByDefault, updateEnableResolve, updateQuickComment, resetTemplates, resetAll }}
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
