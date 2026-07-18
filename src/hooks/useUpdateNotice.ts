import { useCallback, useEffect, useState } from 'react';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';
import { readJsonResponse } from '../lib/http';

interface VersionInfo {
  version: string;
  latest?: string;
}

/**
 * Update-available state for the viewer. The server only reports `latest`
 * when it is strictly newer than the running version, so the client's only
 * job is the per-version dismissal check. Dismissal persists in the shared
 * preferences file, so it holds across browser and desktop shell alike.
 */
export function useUpdateNotice(): { latest: string | null; dismiss: () => void } {
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/version');
        const info = await readJsonResponse<VersionInfo>(res);
        if (!res.ok || !info?.latest) return;
        const prefs = await fetchPreferences();
        if (cancelled) return;
        if (prefs.updateDismissedVersion !== info.latest) setLatest(info.latest);
      } catch {
        // Server unreachable or malformed response: no notice.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (!latest) return;
    void savePreferencesToDisk({ updateDismissedVersion: latest });
    setLatest(null);
  }, [latest]);

  return { latest, dismiss };
}
