import { readFile, rename, open, stat, unlink } from 'fs/promises';
import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

const PREFS_FILENAME = '.md-redline.json';
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 60;
const LOCK_RETRY_BASE_MS = 25;

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

function corruptQuarantinePath(filePath: string): string {
  // Use a high-resolution timestamp + random suffix so back-to-back
  // quarantines never collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(3).toString('hex');
  return `${filePath}.corrupt-${stamp}-${rand}`;
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

/**
 * Acquire a cross-process lock on the preferences file before performing a
 * read-modify-write. The in-process `writeLock` only serializes within a
 * single Node process; running two `mdr` instances against the same home
 * directory would otherwise race the read+write cycle and lose updates.
 *
 * Implementation: O_EXCL sentinel file. If the lock is older than
 * LOCK_STALE_MS we treat it as abandoned (the holder crashed) and steal it.
 */
async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = await open(lockPath, 'wx');
      try {
        await fd.writeFile(`${process.pid}`);
      } finally {
        await fd.close();
      }
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          /* lock already released */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock exists. If it's stale (holder crashed), steal it.
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          try {
            await unlink(lockPath);
          } catch {
            /* someone else just released it */
          }
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately.
        continue;
      }
      // Backoff with a small random jitter to avoid thundering herd.
      const delay = LOCK_RETRY_BASE_MS + Math.floor(Math.random() * LOCK_RETRY_BASE_MS);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw new Error(`Could not acquire preferences lock at ${lockPath}`);
}

/**
 * Read the prefs file and parse it. If the file exists but is unparseable,
 * MOVE it to a quarantine path before returning {}, so the next write does
 * not silently overwrite a file the user might want to recover. The
 * quarantine path lives next to the original so the user finds it.
 *
 * Caller MUST already hold the file lock.
 */
async function readAndQuarantineIfCorrupt(filePath: string): Promise<Preferences> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // Structurally wrong (array / null / scalar). Quarantine and start fresh.
      await rename(filePath, corruptQuarantinePath(filePath)).catch(() => {});
      return {};
    }
    return parsed as Preferences;
  } catch {
    // Unparseable. Quarantine before the next write overwrites it.
    await rename(filePath, corruptQuarantinePath(filePath)).catch(() => {});
    return {};
  }
}

// In-process write lock — keeps a single Node process serialized. The
// cross-process file lock above handles concurrent processes.
let writeLock: Promise<void> = Promise.resolve();

export async function writePreferences(
  homeDir: string,
  patchOrFn: Partial<Preferences> | ((current: Preferences) => Partial<Preferences>),
): Promise<Preferences> {
  const result = await new Promise<Preferences>((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      const filePath = prefsPath(homeDir);
      const releaseLock = await acquireFileLock(filePath);
      try {
        const existing = await readAndQuarantineIfCorrupt(filePath);
        const patch = typeof patchOrFn === 'function' ? patchOrFn(existing) : patchOrFn;
        const merged = { ...existing, ...patch };
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
      } finally {
        await releaseLock();
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
