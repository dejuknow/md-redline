import { open, readFile, rename, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';

// Windows bounces filesystem calls with these codes while another handle is
// open on the path: a virus scanner mid-scan, the search indexer, a sync
// client like OneDrive or Dropbox. They clear on their own within a few
// milliseconds. 5 attempts spread over 100ms of linear backoff (10+20+30+40)
// cover the window without stalling a real failure.
const FS_MAX_ATTEMPTS = 5;
const FS_RETRY_BASE_MS = 10;
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return !!code && TRANSIENT_FS_CODES.has(code);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run a filesystem call, retrying the transient failures above. Every other
 * code (EXDEV, ENOSPC, ENOENT) is a real failure and rethrows on the first
 * attempt.
 *
 * POSIX reports the same codes for permanent conditions instead (an unwritable
 * directory, a sticky bit, a macOS immutable flag, a denied Files-and-Folders
 * grant), so the loop is not free there. FS_MAX_ATTEMPTS caps what a hopeless
 * call wastes at 100ms.
 */
export async function retryTransient<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= FS_MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err)) throw err;
      if (attempt < FS_MAX_ATTEMPTS) await sleep(FS_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

/**
 * Synchronous twin of retryTransient, for the startup path that reads
 * preferences before the event loop is doing anything else. Atomics.wait is
 * the only way to sleep without yielding; blocking for at most 100ms once at
 * boot beats losing the user's trusted roots to a scanner.
 */
export function retryTransientSync<T>(op: () => T): T {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= FS_MAX_ATTEMPTS; attempt++) {
    try {
      return op();
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err)) throw err;
      if (attempt < FS_MAX_ATTEMPTS) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FS_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Write `content` to `path` via a temp file and a rename, so a crash mid-write
 * cannot leave a half-written file. The temp name carries a random suffix so a
 * stale or adversarial `.tmp` cannot block writes, and O_EXCL keeps it from
 * following a symlink.
 *
 * The rename is retried because it is the call Windows bounces most often: it
 * touches both the temp file and the destination, and the destination is the
 * file the user just had open. On any failure the temp file is removed rather
 * than left in the user's folder, where it would show up in Explorer and in
 * `git status`.
 */
async function writeTempFile(tmpPath: string, content: string): Promise<void> {
  const fd = await open(tmpPath, 'wx');
  let failure: unknown;
  try {
    await fd.writeFile(content, 'utf-8');
  } catch (err) {
    failure = err;
  } finally {
    try {
      await fd.close();
    } catch (closeErr) {
      // close surfaces deferred write errors, so a failure here means the temp
      // file is not trustworthy either way. It must not REPLACE an earlier
      // error though: the write's own code is what decides whether this is
      // worth retrying, and a close error can carry a different one.
      failure ??= closeErr;
    }
  }
  if (failure) throw failure;
}

async function renameIntoPlace(tmpPath: string, path: string, content: string): Promise<void> {
  let attempted = false;
  await retryTransient(async () => {
    const firstAttempt = !attempted;
    attempted = true;
    try {
      await rename(tmpPath, path);
    } catch (err) {
      // rename is not idempotent, and retrying re-probes a temp file whose
      // fate may have changed: an attempt that reported failure can still have
      // moved the file, and a sync client can consume the temp file between
      // attempts. Both leave a later attempt failing with ENOENT for a write
      // that already landed. Confirm by content rather than reporting a save
      // that succeeded as failed, and never on the first attempt, where ENOENT
      // means the temp file genuinely never existed.
      if (firstAttempt || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if ((await readFile(path, 'utf-8').catch(() => null)) !== content) throw err;
    }
  });
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeTempFile(tmpPath, content);
    await renameIntoPlace(tmpPath, path, content);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
