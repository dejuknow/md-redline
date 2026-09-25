/**
 * Saves agent before copies (`BaselineStore`) so they survive a server
 * restart (#138), the way review sessions do (#116).
 *
 * One file per copy, in a directory per port, because a copy can be up to
 * 2 MiB and 64 of them would make a single file too heavy to rewrite on every
 * capture. A copy's file is named by its path's hash and its capture time, so
 * a newer copy of the same path is a new file, never an overwrite.
 *
 * `state.json` beside them is the only thing that vouches for a file: it
 * lists the exact files this server holds and when it was last seen alive.
 * At boot, only listed files are restored, and only if that time is within
 * RESTORE_WINDOW_MS, the same window sessions use, so a reboot or a long
 * outage starts clean. Anything unlisted is deleted, which is what keeps a
 * copy that failed to delete, or an older copy of a replaced path, from ever
 * coming back.
 *
 * Order is what makes a crash safe. When a path's copy is replaced or
 * dropped, the old file is first taken off the list, then the new file is
 * written, then the list names it, then the old file is deleted. A crash at
 * any step loses that copy at worst; it never restores the older one in its
 * place.
 */
import { chmod, readFile, readdir, rmdir, unlink } from 'fs/promises';
import { rmdirSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { atomicWriteFile, errorCode, retryTransient, retryTransientSync } from './fs-retry';
import { MAX_BASELINE_BYTES, type Baseline, type BaselineListener } from './baselines';
import {
  FUTURE_SLOP_MS,
  RESTORE_WINDOW_MS,
  isRecord,
  mkdirIfNeeded,
  writePrivateFileSync,
} from './session-persistence';

const PERSISTENCE_VERSION = 1;
const STATE_FILE = 'state.json';

/** Where a given server's copies live: one directory per port, like sessions. */
export function baselinesDirPath(homeDir: string, port: number): string {
  return join(homeDir, '.md-redline', `baselines-${port}`);
}

/** The file one copy is saved in. Hashed, since a path is not a file name. */
export function baselineFileName(entry: { path: string; capturedAt: number }): string {
  const hash = createHash('sha256').update(entry.path).digest('hex').slice(0, 32);
  return `${hash}-${entry.capturedAt}.json`;
}

interface SavedBaseline {
  version: number;
  path: string;
  content: string;
  capturedAt: number;
  agentName?: string;
}

interface SavedState {
  version: number;
  savedAt: number;
  files: string[];
}

function toSaved(entry: Baseline): SavedBaseline {
  const saved: SavedBaseline = {
    version: PERSISTENCE_VERSION,
    path: entry.path,
    content: entry.content,
    capturedAt: entry.capturedAt,
  };
  if (entry.agentName !== undefined) saved.agentName = entry.agentName;
  return saved;
}

function parseState(raw: string): SavedState | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(v) ||
    v.version !== PERSISTENCE_VERSION ||
    typeof v.savedAt !== 'number' ||
    !Number.isFinite(v.savedAt) ||
    !Array.isArray(v.files) ||
    !v.files.every((f) => typeof f === 'string')
  ) {
    return null;
  }
  return { version: v.version, savedAt: v.savedAt, files: v.files as string[] };
}

function parseSaved(raw: string, fileName: string, now: number): Baseline | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(v) ||
    v.version !== PERSISTENCE_VERSION ||
    typeof v.path !== 'string' ||
    typeof v.content !== 'string' ||
    typeof v.capturedAt !== 'number' ||
    !Number.isFinite(v.capturedAt) ||
    // Stamped by a clock running ahead: it would never expire or be evicted.
    v.capturedAt > now + FUTURE_SLOP_MS ||
    (v.agentName !== undefined && typeof v.agentName !== 'string') ||
    // A file whose name does not match its own contents was not written here.
    baselineFileName({ path: v.path, capturedAt: v.capturedAt }) !== fileName
  ) {
    return null;
  }
  const bytes = Buffer.byteLength(v.content, 'utf8');
  if (bytes > MAX_BASELINE_BYTES) return null;
  const entry: Baseline = { path: v.path, content: v.content, capturedAt: v.capturedAt, bytes };
  if (v.agentName !== undefined) entry.agentName = v.agentName as string;
  return entry;
}

function isMissing(err: unknown): boolean {
  return errorCode(err) === 'ENOENT';
}

function removeDirSync(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* not empty, or already gone */
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function removeFileSync(file: string): void {
  try {
    retryTransientSync(() => unlinkSync(file));
  } catch (err) {
    if (!isMissing(err)) console.warn(`[baseline-persistence] could not remove ${file}:`, err);
  }
}

async function removeFile(file: string): Promise<void> {
  await retryTransient(() => unlink(file)).catch((err: unknown) => {
    if (!isMissing(err)) console.warn(`[baseline-persistence] could not remove ${file}:`, err);
  });
}

/**
 * Read the copies saved in `dir`. Never throws. A missing directory is the
 * common first-launch case and returns [] silently.
 *
 * Deletes only what is known to be bad: leftover temp files, files
 * `state.json` does not list, every file when the server was last seen
 * outside the restore window, and a listed file that does not parse, is
 * stamped in the future, or is an older copy of a path with a newer one. A
 * file that merely cannot be read right now is left alone and not restored;
 * so is everything when `state.json` itself cannot be read. Such a file is
 * unlisted from then on, so a later boot deletes it.
 */
export async function loadPersistedBaselines(dir: string, now: Date): Promise<Baseline[]> {
  let names: string[];
  try {
    names = await retryTransient(() => readdir(dir));
  } catch (err) {
    if (!isMissing(err)) {
      console.warn(`[baseline-persistence] could not list ${dir}, starting clean:`, err);
    }
    return [];
  }

  await Promise.all(names.filter((n) => n.endsWith('.tmp')).map((n) => removeFile(join(dir, n))));
  const copies = names.filter((n) => n.endsWith('.json') && n !== STATE_FILE);

  let state: SavedState | null = null;
  try {
    state = parseState(await retryTransient(() => readFile(join(dir, STATE_FILE), 'utf8')));
  } catch (err) {
    if (!isMissing(err)) {
      console.warn(`[baseline-persistence] could not read ${STATE_FILE} in ${dir}:`, err);
      return [];
    }
  }

  let listed = new Set<string>();
  if (state) {
    const age = now.getTime() - state.savedAt;
    if (age > RESTORE_WINDOW_MS || age < -FUTURE_SLOP_MS) {
      if (copies.length > 0) {
        console.warn(
          `[baseline-persistence] saved before copies in ${dir} are outside the restore window; starting clean`,
        );
      }
    } else {
      listed = new Set(state.files);
    }
  }

  const unlisted = copies.filter((n) => !listed.has(n));
  await Promise.all(unlisted.map((n) => removeFile(join(dir, n))));
  if (listed.size === 0) {
    // Nothing to vouch for: a stale or unparseable state.json goes too, and
    // the directory with it once it is empty.
    await removeFile(join(dir, STATE_FILE));
    await rmdir(dir).catch(() => {});
    return [];
  }

  // A few at a time: up to 64 files of 2 MiB each, read before the server
  // serves its first request.
  const loaded = await mapLimit(
    copies.filter((n) => listed.has(n)),
    8,
    async (name) => {
      let raw: string;
      try {
        raw = await retryTransient(() => readFile(join(dir, name), 'utf8'));
      } catch (err) {
        if (!isMissing(err)) {
          console.warn(`[baseline-persistence] could not read ${name}, skipping it:`, err);
        }
        return null;
      }
      const entry = parseSaved(raw, name, now.getTime());
      if (!entry) {
        console.warn(`[baseline-persistence] ${name} is not a saved before copy; removing it`);
        await removeFile(join(dir, name));
      }
      return entry;
    },
  );

  // This server never lists two copies of one path; a state.json that does
  // was edited by hand, and the newest copy is the one kept.
  const byPath = new Map<string, Baseline>();
  for (const entry of loaded) {
    if (!entry) continue;
    const other = byPath.get(entry.path);
    if (other && other.capturedAt >= entry.capturedAt) {
      await removeFile(join(dir, baselineFileName(entry)));
      continue;
    }
    if (other) await removeFile(join(dir, baselineFileName(other)));
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

export interface BaselinePersister extends BaselineListener {
  /**
   * Record that this server is alive now, if it holds any copies, and retry
   * any change an earlier write failed on.
   */
  touch(): void;
  /** Call `touch` every `intervalMs` until `flushSync`. The timer is unref'd. */
  startTouching(intervalMs?: number): void;
  /**
   * Write every change not yet on disk, synchronously, for the exit handler,
   * where no async work runs, and stop all further async writes. Never throws.
   */
  flushSync(): void;
  /** Resolves once every write queued so far has finished. Test seam. */
  idle(): Promise<void>;
}

/**
 * Mirrors the store onto disk. Changes queue per path (a newer change to a
 * path replaces a queued one) and are written in batches, one batch at a
 * time, so a batch never races the one before it. A change whose write fails
 * goes back in the queue for the next batch, `touch`, or the exit flush.
 *
 * After `flushSync`, no async step starts. One that was already handed to the
 * OS (a rename in flight) can still land after it; the window is a few
 * milliseconds at exit, and the same one session-persistence.ts documents.
 */
export function createBaselinePersister(opts: {
  dir: string;
  /** Test seam: replaces the async write primitive (defaults to atomicWriteFile). */
  writeFileAsync?: (path: string, content: string) => Promise<void>;
}): BaselinePersister {
  const { dir, writeFileAsync = atomicWriteFile } = opts;
  const stateFile = join(dir, STATE_FILE);
  /** The file `state.json` should list for each path. */
  const listed = new Map<string, string>();
  /** Changes not yet written: the copy to save, or null to drop the path. */
  const pending = new Map<string, Baseline | null>();
  /** The batch a drain is writing right now, so the exit flush can finish it. */
  const inflight = new Map<string, Baseline | null>();
  let chain: Promise<void> = Promise.resolve();
  let drainQueued = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stateJson = () => {
    const state: SavedState = {
      version: PERSISTENCE_VERSION,
      savedAt: Date.now(),
      files: [...listed.values()],
    };
    return JSON.stringify(state);
  };

  const enqueue = (label: string, op: () => Promise<void>) => {
    chain = chain.then(op).catch((err: unknown) => {
      console.warn(`[baseline-persistence] could not ${label} in ${dir}:`, err);
    });
  };

  async function writePrivate(file: string, content: string): Promise<void> {
    await writeFileAsync(file, content);
    await chmod(file, 0o600).catch(() => {});
  }

  async function writeState(): Promise<void> {
    if (closed) return;
    if (listed.size > 0) await writePrivate(stateFile, stateJson());
    else await removeFile(stateFile);
  }

  /** Take `batch`'s replaced and dropped files off the list; returns them. */
  function unlist(batch: [string, Baseline | null][]): string[] {
    const stale: string[] = [];
    for (const [path, next] of batch) {
      const old = listed.get(path);
      if (old !== undefined && old !== (next ? baselineFileName(next) : null)) {
        listed.delete(path);
        stale.push(old);
      }
    }
    return stale;
  }

  /** Put a change back for a later attempt, unless a newer one is queued. */
  function requeue(path: string, next: Baseline | null): void {
    if (!pending.has(path)) pending.set(path, next);
  }

  async function drain(): Promise<void> {
    drainQueued = false;
    if (closed || pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    for (const [path, next] of batch) inflight.set(path, next);
    try {
      const stale = unlist(batch);
      await mkdirIfNeeded(dir);
      if (stale.length > 0) await writeState();
      await Promise.all(
        batch.map(async ([path, next]) => {
          if (!next) return;
          const name = baselineFileName(next);
          try {
            await writePrivate(join(dir, name), JSON.stringify(toSaved(next)));
            if (!closed) listed.set(path, name);
          } catch (err) {
            console.warn(`[baseline-persistence] could not save the before copy of ${path}:`, err);
            requeue(path, next);
          }
        }),
      );
      await writeState();
      if (closed) return;
      await Promise.all(stale.map((name) => removeFile(join(dir, name))));
      // Nothing held: leave no empty directory behind.
      if (listed.size === 0) await rmdir(dir).catch(() => {});
    } catch (err) {
      console.warn(`[baseline-persistence] could not save before copies in ${dir}:`, err);
      for (const [path, next] of batch) requeue(path, next);
    } finally {
      inflight.clear();
    }
  }

  const scheduleDrain = () => {
    if (drainQueued || closed) return;
    drainQueued = true;
    enqueue('save before copies', drain);
  };

  const persister: BaselinePersister = {
    restored(entry) {
      listed.set(entry.path, baselineFileName(entry));
    },

    stored(entry) {
      pending.set(entry.path, entry);
      scheduleDrain();
    },

    removed(path) {
      pending.set(path, null);
      scheduleDrain();
    },

    touch() {
      if (closed) return;
      if (pending.size > 0) {
        scheduleDrain();
        return;
      }
      if (listed.size === 0) return;
      enqueue('record the save time', async () => {
        await mkdirIfNeeded(dir);
        await writeState();
      });
    },

    startTouching(intervalMs = 60_000) {
      if (timer || closed) return;
      timer = setInterval(() => persister.touch(), intervalMs);
      timer.unref();
    },

    flushSync() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      // The running batch first, then anything queued after it, which is newer.
      const merged = new Map(inflight);
      for (const [path, next] of pending) merged.set(path, next);
      pending.clear();
      // A copy the running batch already wrote and listed needs nothing more.
      const batch = [...merged].filter(
        ([path, next]) => !(next && listed.get(path) === baselineFileName(next)),
      );
      try {
        if (batch.length > 0) {
          const stale = unlist(batch);
          if (stale.length > 0) {
            if (listed.size > 0) writePrivateFileSync(stateFile, stateJson());
            else removeFileSync(stateFile);
          }
          for (const [path, next] of batch) {
            if (!next) continue;
            const name = baselineFileName(next);
            try {
              writePrivateFileSync(join(dir, name), JSON.stringify(toSaved(next)));
              listed.set(path, name);
            } catch (err) {
              console.warn(
                `[baseline-persistence] could not save the before copy of ${path}:`,
                err,
              );
            }
          }
          for (const name of stale) removeFileSync(join(dir, name));
        }
        if (listed.size > 0) {
          writePrivateFileSync(stateFile, stateJson());
        } else {
          removeFileSync(stateFile);
          removeDirSync(dir);
        }
      } catch (err) {
        console.warn(`[baseline-persistence] could not flush before copies in ${dir}:`, err);
      }
    },

    idle() {
      return chain;
    },
  };
  return persister;
}
