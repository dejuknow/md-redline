import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';

const PREFS_FILENAME = '.md-redline.json';

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

export interface AppSettings {
  templates?: { label: string; text: string }[];
  commentMaxLength?: number;
  showTemplatesByDefault?: boolean;
  enableResolve?: boolean;
  quickComment?: boolean;
}

export interface Preferences {
  author?: string;
  settings?: AppSettings;
  theme?: string;
  recentFiles?: RecentFile[];
}

function prefsPath(homeDir: string): string {
  return join(homeDir, PREFS_FILENAME);
}

export async function readPreferences(homeDir: string): Promise<Preferences> {
  try {
    const raw = await readFile(prefsPath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Preferences;
  } catch {
    return {};
  }
}

// Write lock to serialize concurrent writes
let writeLock: Promise<void> = Promise.resolve();

export async function writePreferences(
  homeDir: string,
  patch: Partial<Preferences>,
): Promise<Preferences> {
  const result = await new Promise<Preferences>((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      try {
        const existing = await readPreferences(homeDir);
        const merged = { ...existing, ...patch };
        const filePath = prefsPath(homeDir);
        const tmpPath = filePath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        await rename(tmpPath, filePath);
        resolve(merged);
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}
