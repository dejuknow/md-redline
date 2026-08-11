/**
 * Cross-process advisory lock for read-modify-write cycles on a shared file.
 *
 * In `bin/` for the same reason `fs-atomic.js` is: the CLI writes the user's
 * `.md-redline.json` too, and a lock only works if every writer takes the same
 * one. The server reaches it through `server/preferences.ts`.
 *
 * Types live in `file-lock.d.ts`.
 */

import { open, stat, unlink } from 'fs/promises';

import { FS_RETRY_BUDGET_MS, isTransientFsError, retryTransient, sleep } from './fs-atomic.js';

export const LOCK_SUFFIX = '.lock';

/** Older than this and the holder is assumed to have crashed. */
export const LOCK_STALE_MS = 30_000;

const LOCK_RETRY_BASE_MS = 25;

/**
 * How long a writer waits for the lock before giving up. A holder is running a
 * full read-modify-write, and every syscall in it can itself spend
 * FS_RETRY_BUDGET_MS bouncing off a scanner, so this is expressed as a
 * multiple of that budget rather than picked independently. Tuning the retry
 * budget now moves this with it instead of leaving it silently stale.
 */
export const LOCK_MAX_WAIT_MS = 15 * FS_RETRY_BUDGET_MS;

const LOCK_MAX_ATTEMPTS = Math.ceil(LOCK_MAX_WAIT_MS / LOCK_RETRY_BASE_MS);

/**
 * Thrown when the attempt budget runs out, as opposed to a filesystem error,
 * which is rethrown with its errno intact. Callers word their advice from this
 * distinction: waiting helps for contention and never helps for a permission
 * problem, and an untyped throw made every permanent condition look like the
 * former. `cause` carries the last errno seen, when there was one.
 */
export class LockContentionError extends Error {
  /**
   * @param {string} lockPath
   * @param {unknown} [cause]
   */
  constructor(lockPath, cause) {
    super(`Could not acquire lock at ${lockPath} after ${LOCK_MAX_WAIT_MS}ms`);
    this.name = 'LockContentionError';
    this.code = 'ELOCKBUSY';
    this.lockPath = lockPath;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Acquire a cross-process lock on `filePath` before performing a
 * read-modify-write, and return the release closure. An in-process promise
 * chain only serializes within one Node process; two `mdr` invocations, or the
 * CLI and the server, would otherwise race the read+write cycle and lose one
 * side.
 *
 * Implementation: O_EXCL sentinel file. If the lock is older than
 * LOCK_STALE_MS we treat it as abandoned (the holder crashed) and steal it.
 *
 * @param {string} filePath
 * @returns {Promise<() => Promise<void>>} release closure
 * @throws {LockContentionError} when the attempt budget runs out. Any other
 *   throw is a filesystem error with its errno intact.
 */
export async function acquireFileLock(filePath) {
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  let lastErr;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd;
    try {
      fd = await open(lockPath, 'wx');
    } catch (err) {
      const code = err?.code;
      if (code !== 'EEXIST') {
        lastErr = err;
        // The lock file is created and removed on every write, which makes it
        // the same scanner bait as the temp file. Back off on the transient
        // codes instead of failing the whole write.
        if (!isTransientFsError(err)) throw err;
        await sleep(LOCK_RETRY_BASE_MS);
        continue;
      }
      // Lock exists. If it's stale (holder crashed), steal it.
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (statErr) {
        // ENOENT means the lock vanished between the EEXIST and the stat, so
        // the path is free right now and there is nothing to wait for.
        if (statErr?.code === 'ENOENT') continue;
        // Anything else is a condition that does NOT clear on its own at this
        // speed: a dangling symlink at the lock path (open reports EEXIST
        // while stat follows the link and fails), an unreadable directory, or
        // a scanner bouncing the stat on Windows. Retrying with no delay burns
        // the entire attempt budget in a couple of milliseconds and reports
        // contention for something that is not contention.
        lastErr = statErr;
        await sleep(LOCK_RETRY_BASE_MS);
        continue;
      }
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        try {
          await unlink(lockPath);
        } catch (unlinkErr) {
          // ENOENT is the benign race: someone else released it first.
          if (unlinkErr?.code !== 'ENOENT') {
            // We cannot remove an abandoned lock, so the recovery path this
            // branch exists for will not fire. Back off rather than spinning,
            // and keep the errno so the caller can say what is actually wrong.
            lastErr = unlinkErr;
            await sleep(LOCK_RETRY_BASE_MS);
          }
        }
        continue;
      }
      // Backoff with a small random jitter to avoid thundering herd.
      await sleep(LOCK_RETRY_BASE_MS + Math.floor(Math.random() * LOCK_RETRY_BASE_MS));
      continue;
    }

    // The lock file exists and is ours from here. Anything that fails before
    // we return the release closure has to remove it, or the next attempt
    // deadlocks against our own orphan: it is far too young for the
    // stale-steal branch above, so the loop burns every remaining attempt and
    // then blocks all writers until LOCK_STALE_MS elapses.
    let writeErr;
    try {
      await fd.writeFile(`${process.pid}`);
    } catch (err) {
      writeErr = err;
    }
    // Close before unlinking: Windows refuses to remove a file that still has
    // an open handle, which would defeat the cleanup below. The pid is only a
    // debugging aid (staleness is decided by mtime), so a failed close on the
    // success path is not worth failing the write over.
    await fd.close().catch(() => {});
    if (writeErr) {
      await unlink(lockPath).catch(() => {});
      if (!isTransientFsError(writeErr)) throw writeErr;
      await sleep(LOCK_RETRY_BASE_MS);
      continue;
    }

    return async () => {
      try {
        await retryTransient(() => unlink(lockPath));
      } catch (err) {
        if (err?.code === 'ENOENT') return;
        // An orphaned lock blocks every writer, in this process and any other
        // mdr instance, until it ages out. Never silent.
        console.error(
          `Could not release the lock at ${lockPath}; writes are ` +
            `blocked until it ages out after ${LOCK_STALE_MS}ms:`,
          err,
        );
      }
    };
  }
  throw new LockContentionError(lockPath, lastErr);
}
