import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';
import { readJsonResponse } from '../lib/http';

interface VersionInfo {
  version: string;
  latest?: string;
  updateCheckPending?: boolean;
}

const PENDING_RETRY_MS = 250;
const VERSION_POLL_MS = 5 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;

/**
 * Update-available state for the viewer, plus whether the server this tab
 * is talking to was restarted onto a different version (#116). The server
 * only reports `latest` when it is strictly newer than the running version,
 * so the client's only job there is the per-version dismissal check.
 * Dismissal persists in the shared preferences file, so it holds across
 * browser and desktop shell alike.
 *
 * `reloadReady` compares every successful poll's `version` against the
 * first one this tab saw. It is not dismissible: unlike the "a new release
 * exists" notice, there is nothing to remember across visits, since the tab
 * already knows it is stale for its own lifetime and a reload clears it.
 */
export function useUpdateNotice(): {
  latest: string | null;
  dismiss: () => void;
  reloadReady: boolean;
} {
  const [latest, setLatest] = useState<string | null>(null);
  const [reloadReady, setReloadReady] = useState(false);
  const initialVersionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      let nextDelay = ERROR_RETRY_MS;
      try {
        const res = await fetch('/api/version');
        const info = await readJsonResponse<VersionInfo>(res);
        if (!res.ok || !info) return;
        nextDelay = info.updateCheckPending ? PENDING_RETRY_MS : VERSION_POLL_MS;

        if (initialVersionRef.current === null) {
          initialVersionRef.current = info.version;
        } else if (info.version !== initialVersionRef.current && !cancelled) {
          setReloadReady(true);
        }

        if (info.latest) {
          const prefs = await fetchPreferences();
          if (!cancelled) {
            setLatest(prefs.updateDismissedVersion === info.latest ? null : info.latest);
          }
        } else if (!info.updateCheckPending && !cancelled) {
          setLatest(null);
        }
      } catch {
        // Server unreachable or malformed response: no notice, and the
        // recorded version is left untouched.
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), nextDelay);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback(() => {
    if (!latest) return;
    void savePreferencesToDisk({ updateDismissedVersion: latest });
    setLatest(null);
  }, [latest]);

  return { latest, dismiss, reloadReady };
}
