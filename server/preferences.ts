import { readFile, rename } from 'fs/promises';
import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { atomicWriteFile, retryTransient, retryTransientSync } from './fs-retry';
import { acquireFileLock } from '../bin/file-lock.js';
import {
  DOC_WIDTHS,
  PROSE_FONTS,
  PROSE_SIZES,
  type AppSettings as ClientAppSettings,
  type CommentTemplate,
} from '../src/lib/settings';

const PREFS_FILENAME = '.md-redline.json';

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

export interface UpdateCheckCache {
  latestKnown: string;
  checkedAt: string;
}

export type AppSettings = Partial<ClientAppSettings>;

export interface Preferences {
  author?: string;
  settings?: AppSettings;
  theme?: string;
  recentFiles?: RecentFile[];
  trustedRoots?: string[];
  /** Server-owned registry-check cache. The HTTP PUT route strips this key
   * from client bodies; only the server's update checker writes it. */
  updateCheck?: UpdateCheckCache;
  /** Viewer dismissal of the update notice, per latest-version string. */
  updateDismissedVersion?: string;
}

function prefsPath(homeDir: string): string {
  return join(homeDir, PREFS_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeRecentFile(value: unknown): RecentFile | null {
  if (!isPlainObject(value)) return null;
  if (
    typeof value.path !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.openedAt !== 'string'
  ) {
    return null;
  }
  return { path: value.path, name: value.name, openedAt: value.openedAt };
}

function sanitizeTemplate(value: unknown): CommentTemplate | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.label !== 'string' || typeof value.text !== 'string') return null;
  return { label: value.label, text: value.text };
}

function sanitizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.includes(value as T) ? (value as T) : undefined;
}

/**
 * One sanitizer per client settings field, returning the cleaned value or
 * undefined to drop it. The mapped type over the client's AppSettings makes
 * this exhaustive: adding a field to AppSettings in src/lib/settings.ts
 * without adding its sanitizer here is a compile error, so the persistence
 * whitelist can never silently drift behind the client again.
 */
const SETTING_SANITIZERS: {
  [K in keyof ClientAppSettings]-?: (value: unknown) => ClientAppSettings[K] | undefined;
} = {
  templates: (v) =>
    Array.isArray(v)
      ? v.map(sanitizeTemplate).filter((t): t is CommentTemplate => t !== null)
      : undefined,
  commentMaxLength: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  showTemplatesByDefault: sanitizeBoolean,
  enableResolve: sanitizeBoolean,
  quickComment: sanitizeBoolean,
  mermaidFullscreenPanelCollapsed: sanitizeBoolean,
  proseFont: (v) => sanitizeEnum(PROSE_FONTS, v),
  docWidth: (v) => sanitizeEnum(DOC_WIDTHS, v),
  proseSize: (v) => sanitizeEnum(PROSE_SIZES, v),
};

function sanitizeSettings(value: unknown): AppSettings | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SETTING_SANITIZERS) as (keyof ClientAppSettings)[]) {
    if (!(key in value)) continue;
    const sanitized = SETTING_SANITIZERS[key](value[key]);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out as AppSettings;
}

/**
 * Whitelist-validate a Preferences patch coming from an untrusted source
 * (HTTP body, on-disk file). Unknown top-level keys are dropped, wrong-typed
 * fields are dropped, and well-known nested shapes are sanitized field by
 * field. The goal is that anything coming out of this function can be safely
 * spread into the on-disk Preferences object without risk of garbage shapes
 * propagating to consumers that trust the type via `as Preferences`.
 *
 * Note: prototype-pollution via `__proto__` is not a concern with object
 * spread (ES spec; spread copies own enumerable properties, not the
 * `__proto__` setter), but this also rejects any such key for clarity.
 */
export function sanitizePreferencesPatch(input: unknown): Partial<Preferences> {
  if (!isPlainObject(input)) return {};
  const out: Partial<Preferences> = {};
  if (typeof input.author === 'string') out.author = input.author;
  if (typeof input.theme === 'string') out.theme = input.theme;
  if (Array.isArray(input.recentFiles)) {
    out.recentFiles = input.recentFiles
      .map(sanitizeRecentFile)
      .filter((f): f is RecentFile => f !== null);
  }
  if (Array.isArray(input.trustedRoots)) {
    out.trustedRoots = input.trustedRoots.filter((p): p is string => typeof p === 'string');
  }
  if ('settings' in input) {
    const settings = sanitizeSettings(input.settings);
    if (settings) out.settings = settings;
  }
  if (typeof input.updateDismissedVersion === 'string') {
    out.updateDismissedVersion = input.updateDismissedVersion;
  }
  if (isPlainObject(input.updateCheck)) {
    const { latestKnown, checkedAt } = input.updateCheck;
    if (typeof latestKnown === 'string' && typeof checkedAt === 'string') {
      out.updateCheck = { latestKnown, checkedAt };
    }
  }
  return out;
}

function corruptQuarantinePath(filePath: string): string {
  // Use a high-resolution timestamp + random suffix so back-to-back
  // quarantines never collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(3).toString('hex');
  return `${filePath}.corrupt-${stamp}-${rand}`;
}

export interface PreferencesRead {
  prefs: Preferences;
  /**
   * True when a prefs file exists but could not be read. The {} fallback is
   * indistinguishable from "no prefs yet", and that ambiguity is destructive:
   * a caller that derives state from {} and writes it back with a plain patch
   * overwrites the very keys it could not see, because writePreferences
   * merges shallowly and a key present in the patch always beats the
   * under-lock re-read. Callers that persist derived state MUST check this
   * and skip the write. Consumers that only read can ignore it.
   *
   * A corrupt (unparseable) file does not set this: the write path quarantines
   * it, so the original bytes survive and starting fresh is correct.
   */
  unreadable: boolean;
}

function emptyOnReadFailure(err: unknown, homeDir: string): PreferencesRead {
  const code = (err as NodeJS.ErrnoException).code;
  // ENOENT is the ordinary "no prefs yet" case; a SyntaxError has no code.
  const unreadable = !!code && code !== 'ENOENT';
  if (unreadable) {
    console.error(
      `Could not read preferences at ${prefsPath(homeDir)} (${code}); ` +
        'continuing without saved settings for this session:',
      err,
    );
  }
  return { prefs: {}, unreadable };
}

export async function readPreferencesResult(homeDir: string): Promise<PreferencesRead> {
  try {
    const raw = await retryTransient(() => readFile(prefsPath(homeDir), 'utf-8'));
    return { prefs: sanitizePreferencesPatch(JSON.parse(raw)) as Preferences, unreadable: false };
  } catch (err) {
    return emptyOnReadFailure(err, homeDir);
  }
}

export function readPreferencesSyncResult(homeDir: string): PreferencesRead {
  try {
    const raw = retryTransientSync(() => readFileSync(prefsPath(homeDir), 'utf-8'));
    return { prefs: sanitizePreferencesPatch(JSON.parse(raw)) as Preferences, unreadable: false };
  } catch (err) {
    return emptyOnReadFailure(err, homeDir);
  }
}

export async function readPreferences(homeDir: string): Promise<Preferences> {
  return (await readPreferencesResult(homeDir)).prefs;
}

export function readPreferencesSync(homeDir: string): Preferences {
  return readPreferencesSyncResult(homeDir).prefs;
}

/**
 * Move a prefs file we cannot parse out of the way, so the write that follows
 * does not land on top of it. These are the user's own settings, and after
 * that write they are gone, so neither outcome may be silent: on success the
 * log is how they find the copy, and on failure it is the only warning they
 * will ever get that the bytes are about to be destroyed.
 *
 * The rename is retried, which off Windows is a single attempt anyway. What it
 * must not do is throw: the caller cannot proceed with a file it cannot read,
 * and refusing to write would leave the app unable to save a setting ever
 * again until the user intervened by hand.
 */
async function quarantineCorruptPrefs(filePath: string, reason: string): Promise<void> {
  const quarantinePath = corruptQuarantinePath(filePath);
  try {
    await retryTransient(() => rename(filePath, quarantinePath));
    console.error(
      `Preferences at ${filePath} were ${reason}. Moved the file to ` +
        `${quarantinePath} and starting fresh.`,
    );
  } catch (err) {
    console.error(
      `Preferences at ${filePath} were ${reason} and could not be moved to ` +
        `${quarantinePath}. The next write overwrites them and they cannot be ` +
        'recovered afterwards:',
      err,
    );
  }
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
    // Retried for the same reason the replace below is: a transient failure
    // here aborts the whole write, which is what silently dropped the
    // trustedRoots migration on Windows.
    raw = await retryTransient(() => readFile(filePath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      // Structurally wrong (array / null / scalar). Quarantine and start fresh.
      await quarantineCorruptPrefs(filePath, 'not a JSON object');
      return {};
    }
    // Strip unknown keys / wrong-typed fields before merging. The cast is
    // safe because sanitizePreferencesPatch only emits keys that match the
    // Preferences type.
    return sanitizePreferencesPatch(parsed) as Preferences;
  } catch {
    // Unparseable. Quarantine before the next write overwrites it.
    await quarantineCorruptPrefs(filePath, 'not valid JSON');
    return {};
  }
}

// In-process write lock — keeps a single Node process serialized. The
// cross-process file lock above handles concurrent processes.
let writeLock: Promise<void> = Promise.resolve();

export type PreferencesPatch =
  | Partial<Preferences>
  // The HTTP layer hands us un-validated request bodies; sanitization is
  // applied before merge so unknown shapes are dropped, not persisted.
  | Record<string, unknown>;

export type PreferencesPatchFn = (current: Preferences) => Partial<Preferences>;

/** Read-modify-write the prefs file. Caller must serialize on `writeLock`. */
async function writeLocked(
  filePath: string,
  patchOrFn: PreferencesPatch | PreferencesPatchFn,
): Promise<Preferences> {
  const releaseLock = await acquireFileLock(filePath);
  try {
    const existing = await readAndQuarantineIfCorrupt(filePath);
    const rawPatch: unknown = typeof patchOrFn === 'function' ? patchOrFn(existing) : patchOrFn;
    // Sanitize the patch even when it comes from a function callback,
    // because the callback can be passed untrusted data via writePreferences
    // call sites that forward HTTP request bodies.
    const patch = sanitizePreferencesPatch(rawPatch);
    const merged = { ...existing, ...patch };
    await atomicWriteFile(filePath, JSON.stringify(merged, null, 2) + '\n');
    return merged;
  } finally {
    await releaseLock();
  }
}

export async function writePreferences(
  homeDir: string,
  patchOrFn: PreferencesPatch | PreferencesPatchFn,
): Promise<Preferences> {
  const result = await new Promise<Preferences>((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      // Everything, acquisition included, has to settle one side of this
      // promise. A throw that escapes the callback settles neither: the caller
      // awaits forever and `writeLock` becomes a rejected promise that wedges
      // every later write in the process. Settling after writeLocked returns
      // also means the lock file is gone by the time the caller observes the
      // result.
      try {
        resolve(await writeLocked(prefsPath(homeDir), patchOrFn));
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
