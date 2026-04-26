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
  hydrated: boolean;
  updateTemplates: (templates: CommentTemplate[]) => void;
  updateCommentMaxLength: (maxLength: number) => void;
  updateShowTemplatesByDefault: (show: boolean) => void;
  updateEnableResolve: (enable: boolean) => void;
  updateQuickComment: (quick: boolean) => void;
  updateMermaidFullscreenPanelCollapsed: (collapsed: boolean) => void;
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
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  // Buffer mutations made during the brief async hydrate window. When the
  // disk read finishes we replay them on top of the on-disk settings, then
  // persist. Without this, an early toggle that fires before hydrate would
  // either be lost (if hydrate overwrites it) or would clobber the entire
  // disk file with defaults+toggle (if we skipped hydrate to keep it).
  const pendingPatchRef = useRef<Partial<AppSettings> | null>(null);

  // Hydrate from disk on mount. Disk is the source of truth.
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled) return;
      const fromDisk =
        prefs.settings && typeof prefs.settings === 'object'
          ? parseSettings(prefs.settings)
          : DEFAULT_SETTINGS;
      const patch = pendingPatchRef.current;
      pendingPatchRef.current = null;
      const merged = patch ? { ...fromDisk, ...patch } : fromDisk;
      setSettings(merged);
      hydratedRef.current = true;
      setHydrated(true);
      // If the user toggled something before hydrate finished, the merged
      // result needs to land on disk so it isn't lost on next reload.
      if (patch) persist(merged);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    if (!hydratedRef.current) {
      // Buffer this mutation; the hydrate effect will replay it.
      pendingPatchRef.current = { ...(pendingPatchRef.current ?? {}), ...patch };
      setSettings((prev) => ({ ...prev, ...patch }));
      return;
    }
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

  const updateMermaidFullscreenPanelCollapsed = useCallback(
    (mermaidFullscreenPanelCollapsed: boolean) => update({ mermaidFullscreenPanelCollapsed }),
    [update],
  );

  const resetTemplates = useCallback(() => update({ templates: DEFAULT_TEMPLATES }), [update]);

  const resetAll = useCallback(() => {
    if (!hydratedRef.current) {
      pendingPatchRef.current = { ...DEFAULT_SETTINGS };
      setSettings(DEFAULT_SETTINGS);
      return;
    }
    setSettings(DEFAULT_SETTINGS);
    persist(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        hydrated,
        updateTemplates,
        updateCommentMaxLength,
        updateShowTemplatesByDefault,
        updateEnableResolve,
        updateQuickComment,
        updateMermaidFullscreenPanelCollapsed,
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
