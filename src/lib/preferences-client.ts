import { readJsonResponse } from './http';

export interface RecentFileEntry {
  path: string;
  name: string;
  openedAt: string;
}

export interface DiskPreferences {
  author?: string;
  settings?: Record<string, unknown>;
  theme?: string;
  recentFiles?: RecentFileEntry[];
  updateDismissedVersion?: string;
}

async function requestPreferences(): Promise<DiskPreferences> {
  try {
    const res = await fetch('/api/preferences');
    const data = await readJsonResponse<DiskPreferences>(res);
    if (!res.ok || !data) return {};
    return data;
  } catch {
    return {};
  }
}

let inFlight: Promise<DiskPreferences> | null = null;

/**
 * Read the on-disk preferences, sharing a request already in flight.
 *
 * Five independent consumers hydrate from this on mount (settings, theme,
 * author, recent files, the localStorage migration) and each one used to open
 * its own request, so every page load asked the server to read and parse the
 * same file five times over. The server reads it per request, and on Windows
 * each read can spend the whole filesystem retry budget, so the cost of the
 * duplicates is not just a few extra sockets.
 *
 * Only concurrent calls share. The result is not cached, so the update
 * notice's five-minute poll still sees fresh data, and a read that starts
 * after a save reflects it. The one stale window is a call that joins a
 * request already open when a save lands, which is a single request wide and
 * behind every caller here, all of which read once on mount.
 */
export function fetchPreferences(): Promise<DiskPreferences> {
  if (!inFlight) {
    inFlight = requestPreferences().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Only for tests, which share a module instance across cases. */
export function resetPreferencesRequestForTests(): void {
  inFlight = null;
}

export async function savePreferencesToDisk(patch: Partial<DiskPreferences>): Promise<boolean> {
  try {
    const res = await fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    // Server unavailable — silently fail, localStorage is the fallback
    return false;
  }
}

const MIGRATED_KEY = 'md-redline-migrated-to-disk';

export async function migrateLocalStorageToDisk(): Promise<void> {
  // Skip if already migrated
  if (localStorage.getItem(MIGRATED_KEY)) return;

  try {
    const existing = await fetchPreferences();
    // If dotfile already has data, mark as migrated and skip
    if (Object.keys(existing).length > 0) {
      localStorage.setItem(MIGRATED_KEY, '1');
      return;
    }

    // Collect from localStorage
    const patch: DiskPreferences = {};

    const settingsRaw = localStorage.getItem('md-redline-settings');
    if (settingsRaw) {
      try {
        patch.settings = JSON.parse(settingsRaw);
      } catch {
        /* ignore */
      }
    }

    const theme = localStorage.getItem('theme');
    if (theme) patch.theme = theme;

    const recentRaw = localStorage.getItem('md-redline-recent-files');
    if (recentRaw) {
      try {
        patch.recentFiles = JSON.parse(recentRaw);
      } catch {
        /* ignore */
      }
    }

    if (Object.keys(patch).length > 0) {
      const saved = await savePreferencesToDisk(patch);
      if (!saved) return;
    }

    // Remove migrated keys from localStorage (keep theme for next-themes flash-free init)
    localStorage.removeItem('md-redline-author');
    localStorage.removeItem('md-redline-settings');
    localStorage.removeItem('md-redline-recent-files');
    // Note: do NOT remove 'theme' — next-themes reads it synchronously on startup

    localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    // Migration failed — will retry next load
  }
}
