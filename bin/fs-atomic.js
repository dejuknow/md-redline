/**
 * Crash-safe file writes and the Windows transient-failure retry.
 *
 * Lives in `bin/` rather than `server/` because the CLI is plain JS shipped as
 * is and cannot import a `.ts` module, while the server can import this
 * through `server/fs-retry.ts` (the same arrangement `server/env.ts` has with
 * `bin/ports.js`). Both sides therefore share one implementation instead of
 * two that drift: the CLI writes the user's prefs file and Claude Desktop's
 * MCP config, both of which the server or another tool may also be writing.
 *
 * Types live in `fs-atomic.d.ts`. The tests live in `server/fs-retry.test.ts`,
 * not beside this file: `server/fs-retry.ts` is a re-export with no logic of
 * its own, so those cover this module directly, and a second suite here would
 * be duplicate surface rather than new coverage. `file-lock.js` is the opposite
 * case and has its own.
 */

import { chmod, open, readFile, rename, stat, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';

// Windows bounces filesystem calls with these codes while another handle is
// open on the path: a virus scanner mid-scan, the search indexer, a sync
// client like OneDrive or Dropbox. They clear on their own within a few
// milliseconds. 5 attempts spread over 100ms of linear backoff (10+20+30+40)
// cover the window without stalling a real failure.
export const FS_MAX_ATTEMPTS = 5;
export const FS_RETRY_BASE_MS = 10;
/**
 * Wall-clock a hopeless call can spend inside retryTransient: the sum of the
 * linear backoffs between attempts. Exported so callers that hand-roll their
 * own contention loop can size themselves against it instead of drifting apart
 * silently.
 */
export const FS_RETRY_BUDGET_MS =
  ((FS_MAX_ATTEMPTS * (FS_MAX_ATTEMPTS - 1)) / 2) * FS_RETRY_BASE_MS;

/**
 * Contention, on every platform. A handle is open on the path right now and
 * will not be shortly: a scanner or indexer on Windows, and on POSIX the
 * network and cloud-sync filesystems md-redline documents actually live on
 * (SMB, NFS, and the FUSE and FileProvider mounts behind Dropbox, Google Drive
 * and iCloud), which return it while the provider holds or hydrates a file.
 */
const CONTENTION_FS_CODES = new Set(['EBUSY']);

/**
 * Contention on Windows, permission on POSIX. Windows AV and sync clients
 * bounce calls with these while they hold a handle, so retrying clears them.
 * POSIX reports the same two only for conditions that are permanent by
 * construction: an unwritable directory, a sticky bit, a macOS `uchg` flag, a
 * denied Files-and-Folders grant. There, every attempt fails identically and
 * the loop only delays the error the user needs to see. Reproduced on Darwin
 * against a `uchg` document, on the app's highest-frequency write path.
 *
 * Gating by errno rather than by platform matters: a blanket win32 check would
 * also stop retrying EBUSY above, which is genuinely transient everywhere.
 */
const WINDOWS_ONLY_TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES']);

/**
 * The errno carried by a caught value, or undefined when it has none.
 *
 * `catch` binds `unknown`, and almost every handler across `bin/` wants the
 * same one thing out of it. Written inline that is the same unchecked cast
 * repeated a dozen times over; the cast is the part worth having in exactly one
 * place, where it can say what it is assuming.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function errorCode(err) {
  return /** @type {NodeJS.ErrnoException | null | undefined} */ (err)?.code;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientFsError(err) {
  const code = errorCode(err);
  if (!code) return false;
  if (CONTENTION_FS_CODES.has(code)) return true;
  // Read per call rather than captured at module load, so the tests can
  // exercise both sides on whichever platform they run.
  return process.platform === 'win32' && WINDOWS_ONLY_TRANSIENT_FS_CODES.has(code);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run a filesystem call, retrying the transient failures above. Every other
 * code (EXDEV, ENOSPC, ENOENT) is a real failure and rethrows on the first
 * attempt, as do EPERM and EACCES off Windows (see isTransientFsError).
 *
 * @template T
 * @param {() => Promise<T>} op
 * @returns {Promise<T>}
 */
export async function retryTransient(op) {
  let lastErr;
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
 *
 * @template T
 * @param {() => T} op
 * @returns {T}
 */
export function retryTransientSync(op) {
  let lastErr;
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
 * Both the create and the rename are retried, because both are calls Windows
 * bounces: the create because AV hooks file creation, the rename because it
 * touches the destination the user just had open.
 *
 * On any failure the temp file is removed, so it does not sit in the user's
 * folder showing up in Explorer and in `git status`. That cleanup is single
 * attempt and its own errors are swallowed, which means the same interference
 * that failed the save can also leave the `.tmp` behind: a deliberate trade,
 * since the worst case is one stray file and the alternative is more machinery
 * on the path where something is already going wrong. It is the one syscall
 * here that is neither retried nor reported.
 *
 * @param {string} tmpPath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTempFile(tmpPath, content) {
  // Creating the temp file is bounceable for the same reason the rename is:
  // Windows AV and sync clients hook file creation, and this is the first
  // syscall of every save. Only the open retries. The write and the close are
  // not idempotent against a file that now exists, and re-running them would
  // need the O_EXCL create dropped, which is what keeps a symlink planted at
  // tmpPath from being followed.
  //
  // A create that bounces AFTER the file lands makes the next attempt fail
  // EEXIST, which is permanent and ends the save. That is the intended
  // outcome: the caller removes the orphan, the destination is untouched, and
  // the user retries. Recovering the file instead would mean unlinking a path
  // this process cannot prove it owns.
  const fd = await retryTransient(() => open(tmpPath, 'wx'));
  let failure;
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

/**
 * @param {string} tmpPath
 * @param {string} path
 * @param {string} content
 * @returns {Promise<void>}
 */
async function renameIntoPlace(tmpPath, path, content) {
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
      if (firstAttempt || errorCode(err) !== 'ENOENT') throw err;
      if ((await readFile(path, 'utf-8').catch(() => null)) !== content) throw err;
    }
  });
}

/**
 * Carry the destination's permission bits over to the replacement.
 *
 * A temp file is created at the default 0600-and-umask, so without this a
 * rename silently RELAXES the mode of anything the user or another tool had
 * tightened: a 0600 file comes back 0644. That matters most for the file this
 * module does not own, Claude Desktop's MCP config, because it holds every
 * other server's `env` block and those routinely carry API tokens.
 *
 * Best effort in both directions. No destination yet (the ordinary create) and
 * there is nothing to copy; a chmod that fails leaves the default, which is
 * never more permissive than what a fresh file would have got anyway, and is
 * not worth failing an otherwise good save over.
 *
 * @param {string} tmpPath
 * @param {string} path
 * @returns {Promise<void>}
 */
async function inheritMode(tmpPath, path) {
  try {
    const existing = await stat(path);
    await chmod(tmpPath, existing.mode & 0o7777);
  } catch {
    /* no destination, or a filesystem without modes (Windows) */
  }
}

/**
 * @param {string} path
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(path, content) {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeTempFile(tmpPath, content);
    await inheritMode(tmpPath, path);
    await renameIntoPlace(tmpPath, path, content);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
