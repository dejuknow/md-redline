import { readFile, rename, open } from 'fs/promises';
import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
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
  trustedRoots?: string[];
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

export function readPreferencesSync(homeDir: string): Preferences {
  try {
    const raw = readFileSync(prefsPath(homeDir), 'utf-8');
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
  patchOrFn: Partial<Preferences> | ((current: Preferences) => Partial<Preferences>),
): Promise<Preferences> {
  const result = await new Promise<Preferences>((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      try {
        const existing = await readPreferences(homeDir);
        const patch = typeof patchOrFn === 'function' ? patchOrFn(existing) : patchOrFn;
        const merged = { ...existing, ...patch };
        const filePath = prefsPath(homeDir);
        const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
        const fd = await open(tmpPath, 'wx');
        try {
          await fd.writeFile(JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        } finally {
          await fd.close();
        }
        await rename(tmpPath, filePath);
        resolve(merged);
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}

/**
 * Atomically append a path to the trustedRoots list, deduping against the
 * current contents. Runs inside the existing writeLock so concurrent calls
 * (e.g. from rapid pick-file invocations) are serialized.
 */
export async function addTrustedRoot(homeDir: string, path: string): Promise<void> {
  await writePreferences(homeDir, (current) => {
    const list = current.trustedRoots ?? [];
    if (list.includes(path)) return {};
    return { trustedRoots: [...list, path] };
  });
}
