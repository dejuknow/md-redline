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
}

export async function fetchPreferences(): Promise<DiskPreferences> {
  try {
    const res = await fetch('/api/preferences');
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
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

    const author = localStorage.getItem('md-redline-author');
    if (author) patch.author = author;

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
