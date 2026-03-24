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

  const persist = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const updateTemplates = useCallback(
    (templates: CommentTemplate[]) => {
      persist({ ...settings, templates });
    },
    [settings, persist],
  );

  const updateCommentMaxLength = useCallback(
    (commentMaxLength: number) => {
      persist({ ...settings, commentMaxLength });
    },
    [settings, persist],
  );

  const updateShowTemplatesByDefault = useCallback(
    (showTemplatesByDefault: boolean) => {
      persist({ ...settings, showTemplatesByDefault });
    },
    [settings, persist],
  );

  const updateEnableResolve = useCallback(
    (enableResolve: boolean) => {
      persist({ ...settings, enableResolve });
    },
    [settings, persist],
  );

  const updateQuickComment = useCallback(
    (quickComment: boolean) => {
      persist({ ...settings, quickComment });
    },
    [settings, persist],
  );

  const resetTemplates = useCallback(() => {
    persist({ ...settings, templates: DEFAULT_TEMPLATES });
  }, [settings, persist]);

  const resetAll = useCallback(() => {
    persist(DEFAULT_SETTINGS);
  }, [persist]);

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
