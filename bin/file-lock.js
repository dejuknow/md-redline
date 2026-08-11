/**
 * Cross-process advisory lock for read-modify-write cycles on a shared file.
 *
 * In `bin/` for the same reason `fs-atomic.js` is: the CLI writes the user's
 * `.md-redline.json` too, and a lock only works if every writer takes the same
 * one. The server reaches it through `server/preferences.ts`.
 *
 * Types live in `file-lock.d.ts`.
 */

import { open, readFile, stat, unlink } from 'fs/promises';
import { readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { constants as osConstants } from 'os';

import {
  errorCode,
  FS_RETRY_BUDGET_MS,
  isTransientFsError,
  retryTransient,
  sleep,
} from './fs-atomic.js';

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
 * What a holder writes into its lock file, and the only evidence that the lock
 * on disk is still the one it took.
 *
 * The pid alone cannot do this job. It is not unique over time (pids are
 * reused), it is not unique across machines (the prefs file lives on synced and
 * network mounts), and a process that takes the lock twice in sequence writes
 * the same bytes both times. A uuid alongside it makes every acquisition
 * distinguishable from every other, and keeping the pid first leaves the file
 * as readable to someone debugging an abandoned lock as it was before.
 *
 * @returns {string}
 */
function mintHolderToken() {
  return `${process.pid} ${randomUUID()}`;
}

/**
 * Locks this process holds right now, keyed by lock path, valued by the token
 * that proves each one is ours. An interrupt between acquiring and the caller's
 * `finally` leaves the file behind otherwise, and an orphan wedges every writer
 * of that path (this process, another mdr, the server) until it ages out
 * LOCK_STALE_MS later. `mdr --restrict` is the shortest way to see it: one
 * Ctrl-C inside a window the user has no way to know they are in.
 *
 * @type {Map<string, string>}
 */
const heldLocks = new Map();

/**
 * Signals that terminate the process by default, so a caller's `finally` never
 * runs. `exit` is separately necessary: it does NOT fire on a default signal
 * death, and the signal handlers below do not fire when something else's
 * handler calls process.exit first, which is exactly what the server does.
 */
const CLEANUP_SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/** @type {Map<string, () => void>} */
const installedSignalHandlers = new Map();
let exitHandlerInstalled = false;

/**
 * Remove every lock still held, synchronously, because this is all that a
 * signal handler or an `exit` listener can do. Ownership is re-checked the same
 * way release does it: a lock stolen while we stalled belongs to someone else
 * now, and taking it with us on the way out is the failure this module works
 * hardest to prevent.
 *
 * Best effort by construction. Nothing is retried and no error is reported: the
 * process is on its way out, there is no one left to tell, and a lock left
 * behind here is the exact 30-second orphan that this path exists to make rare
 * rather than certain.
 */
function releaseHeldLocksSync() {
  for (const [lockPath, token] of heldLocks) {
    try {
      if (readFileSync(lockPath, 'utf-8') === token) unlinkSync(lockPath);
    } catch {
      /* already gone, or unreadable; either way there is nothing safe to do */
    }
  }
  // Cleared whether or not each unlink worked, so a re-raised signal cannot
  // walk this list a second time.
  heldLocks.clear();
}

/**
 * @param {(typeof CLEANUP_SIGNALS)[number]} signal
 * @returns {void}
 */
function handleTerminatingSignal(signal) {
  releaseHeldLocksSync();

  // Another listener owns the exit decision (the server shuts down and exits
  // from its own SIGINT handler). Taking it away from them here would cut that
  // shutdown short. The trade this accepts is the mirror of the one above: a
  // handler that keeps running after releasing our lock is left unserialized
  // for the rest of its shutdown, which is bounded and quiet, where the orphan
  // it replaces blocks unrelated processes for a fixed 30 seconds.
  if (process.listenerCount(signal) > 1) return;

  // Nothing else is listening, and merely having a listener has already
  // replaced Node's default disposition: without the re-raise, Ctrl-C would
  // leave the process running. Remove ourselves first so the second delivery
  // reaches that default, and the process dies with the same 128+n status a
  // caller would have seen if this module had never installed anything.
  uninstallCleanupHandlers();
  process.kill(process.pid, signal);
  // Unreachable on POSIX, where the re-raise terminates before returning.
  // Windows has no signal to re-raise, so anything that gets here still has to
  // stop rather than linger with the lock already gone.
  process.exit(128 + (osConstants.signals[signal] ?? 15));
}

function installCleanupHandlers() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', releaseHeldLocksSync);
  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => handleTerminatingSignal(signal);
    installedSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/**
 * Uninstalled as soon as the last lock is released, not left for the life of
 * the process. The server takes this lock on every preferences write, so
 * handlers that accumulated would both leak listeners and keep changing how the
 * process responds to a signal long after the reason for it was gone.
 */
function uninstallCleanupHandlers() {
  if (!exitHandlerInstalled) return;
  exitHandlerInstalled = false;
  process.off('exit', releaseHeldLocksSync);
  for (const [signal, handler] of installedSignalHandlers) process.off(signal, handler);
  installedSignalHandlers.clear();
}

/**
 * @param {string} lockPath
 * @returns {void}
 */
function forgetHeldLock(lockPath) {
  heldLocks.delete(lockPath);
  if (heldLocks.size === 0) uninstallCleanupHandlers();
}

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
 * Because a lock CAN be stolen, holding one is not the same as still holding
 * it: a holder that stalls past LOCK_STALE_MS (the machine suspends, a cloud
 * mount hydrates the file) comes back to a lock path that now belongs to
 * someone else. Every acquisition therefore writes a token that identifies it,
 * and release unlinks only a lock still carrying that token.
 *
 * @param {string} filePath
 * @returns {Promise<() => Promise<void>>} release closure
 * @throws {LockContentionError} when the attempt budget runs out. Any other
 *   throw is a filesystem error with its errno intact.
 */
export async function acquireFileLock(filePath) {
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  const token = mintHolderToken();
  let lastErr;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd;
    try {
      fd = await open(lockPath, 'wx');
    } catch (err) {
      const code = errorCode(err);
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
        if (errorCode(statErr) === 'ENOENT') continue;
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
          // Removing a lock this process does not hold, on the evidence of a
          // stat taken a moment ago. If the abandoned holder released and a
          // third writer acquired in the gap between that stat and this call,
          // this unlinks the new holder's lock instead. No syscall compares and
          // removes in one step, so the window cannot be closed here, only kept
          // to the microseconds between two adjacent calls; the release path is
          // where it was measured in the whole duration of a held lock.
          await unlink(lockPath);
        } catch (unlinkErr) {
          // ENOENT is the benign race: someone else released it first.
          if (errorCode(unlinkErr) !== 'ENOENT') {
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
      await fd.writeFile(token);
    } catch (err) {
      writeErr = err;
    }
    // Close before unlinking: Windows refuses to remove a file that still has
    // an open handle, which would defeat the cleanup below. A close that fails
    // AFTER the token landed is not worth failing the write over; one that
    // failed to flush it leaves a lock this holder can no longer prove is its
    // own, and release treats that the same way it treats a stolen one.
    await fd.close().catch(() => {});
    if (writeErr) {
      await unlink(lockPath).catch(() => {});
      if (!isTransientFsError(writeErr)) throw writeErr;
      await sleep(LOCK_RETRY_BASE_MS);
      continue;
    }

    heldLocks.set(lockPath, token);
    installCleanupHandlers();

    return async () => {
      // Before the unlink, not after: whichever of the two paths gets there
      // first, the other must not try the same removal again.
      forgetHeldLock(lockPath);

      let holder;
      try {
        holder = await retryTransient(() => readFile(lockPath, 'utf-8'));
      } catch (err) {
        // Already gone: released twice, or stolen and released by whoever took
        // it. Either way there is nothing here to remove.
        if (errorCode(err) === 'ENOENT') return;
        // A read that will not succeed proves nothing about who holds the lock,
        // and unlinking on that evidence is exactly the failure this check
        // exists to prevent. Leaving it costs one stale window and then clears
        // on its own; guessing wrong costs mutual exclusion.
        console.error(
          `Could not read the lock at ${lockPath} to confirm it is still ` +
            `ours, so it was left in place; writes are blocked until it ages ` +
            `out after ${LOCK_STALE_MS}ms:`,
          err,
        );
        return;
      }

      if (holder !== token) {
        // Our lock aged past LOCK_STALE_MS while we held it and another writer
        // took it as abandoned. The write we just finished was NOT serialized
        // against theirs, and unlinking this would hand a third writer the same
        // window. Say so: a file that comes back different needs an explanation
        // somewhere, and this is the only place that has one.
        console.error(
          `The lock at ${lockPath} was taken over by another writer while we ` +
            `held it (ours was idle past ${LOCK_STALE_MS}ms), so this write ` +
            `was not serialized against theirs. Leaving their lock in place.`,
        );
        return;
      }

      try {
        await retryTransient(() => unlink(lockPath));
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return;
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
