/**
 * Saves and restores ReviewSessionStore state across a server restart (#116).
 *
 * This module owns serialize, deserialize, file I/O and the write debounce,
 * so review-sessions.ts stays pure and testable (exportState/restoreState do
 * no I/O of their own). See the "Storage" and "When it writes" sections of
 * the design doc for the shape on disk and the write cadence this
 * implements.
 */
import {
  chmod as chmodAsync,
  mkdir as mkdirAsync,
  readFile,
  readdir,
  unlink as unlinkAsync,
} from 'fs/promises';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteFile, retryTransientSync } from './fs-retry';
import type { AskResult, PersistedStoreState } from './review-sessions';

const PERSISTENCE_VERSION = 1;

/**
 * A saved file older than this is a reboot or a long outage, not a quick
 * restart, and its sessions are gone regardless (the tab and any agent will
 * have given up long before this window closes). Matches RESTORE_WINDOW_MS
 * in the design doc.
 */
const RESTORE_WINDOW_MS = 5 * 60_000;

/**
 * How far into the future a `savedAt` may read before it is treated as
 * clock skew or a foreign file rather than a genuine restart. A few seconds
 * covers ordinary clock drift between the write and the next boot's read;
 * anything past that means the file did not come from this machine's clock
 * just now.
 */
const FUTURE_SLOP_MS = 5_000;

/** The on-disk wrapper around a PersistedStoreState: a version tag so a
 * downgrade or a future format never gets parsed as if it matched, plus the
 * moment it was written so a stale file can be told apart from a fresh
 * restart. */
interface PersistedFile extends PersistedStoreState {
  version: number;
  savedAt: number;
}

/** Where a given server's sessions live: one file per port, so two named
 * servers (MD_REDLINE_PORT) never read or write each other's reviews. */
export function sessionsFilePath(homeDir: string, port: number): string {
  return join(homeDir, '.md-redline', `sessions-${port}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((v) => typeof v === 'string'))
  );
}

const TERMINAL_REASONS = new Set([
  'done',
  'finished',
  'user_cancelled',
  'browser_disconnected',
  'agent_silent',
]);

function isTerminalReason(value: unknown): boolean {
  return value === null || (typeof value === 'string' && TERMINAL_REASONS.has(value));
}

function isReviewResult(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.status === 'batch')
    return typeof value.prompt === 'string' && isStringArray(value.commentIds);
  if (value.status === 'done')
    return value.prompt === undefined || typeof value.prompt === 'string';
  if (value.status === 'aborted') return typeof value.reason === 'string';
  return false;
}

function isQueuedBatch(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (!isStringArray(value.commentIds)) return false;
  if (!Array.isArray(value.commentCountsByPath)) return false;
  return value.commentCountsByPath.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'number',
  );
}

const ORIGINS = new Set(['user', 'agent']);
const STATUSES = new Set(['open', 'done', 'aborted']);

/**
 * Enough of PersistedSession's shape to guarantee restoreState can't throw
 * on it: every array field restoreState spreads or iterates is checked to
 * actually be an array, and every id/string field it reads is checked to
 * actually be a string. Not a full structural clone of the type; fields
 * restoreState only assigns through without touching (like terminalResult's
 * inner union) get a lighter check.
 */
function isPersistedSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isStringArray(value.filePaths) &&
    isStringArray(value.originalFilePaths) &&
    isOptionalStringRecord(value.fileAddedAt) &&
    typeof value.enableResolve === 'boolean' &&
    typeof value.origin === 'string' &&
    ORIGINS.has(value.origin) &&
    (value.clientId === undefined || typeof value.clientId === 'string') &&
    (value.author === undefined || typeof value.author === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.lastHeartbeatAt === 'string' &&
    isNullableString(value.lastAgentActivityAt) &&
    typeof value.status === 'string' &&
    STATUSES.has(value.status) &&
    isStringArray(value.sentCommentIds) &&
    typeof value.waitingForAgent === 'boolean' &&
    isNullableString(value.waitingForAgentSince) &&
    typeof value.agentCommentCount === 'number' &&
    isNullableString(value.sessionDoneAt) &&
    isTerminalReason(value.terminalReason) &&
    isNullableString(value.terminalAt) &&
    isReviewResult(value.terminalResult) &&
    isQueuedBatch(value.queuedBatch)
  );
}

function isAskQuestion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.commentId === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.anchor === 'string' &&
    typeof value.text === 'string' &&
    (value.contextBefore === undefined || typeof value.contextBefore === 'string') &&
    (value.contextAfter === undefined || typeof value.contextAfter === 'string')
  );
}

function isPendingAsk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.askId === 'string' &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.questions) &&
    value.questions.every(isAskQuestion)
  );
}

function isAskResult(value: unknown): value is AskResult {
  if (!isRecord(value)) return false;
  if (value.status === 'reply') {
    return (
      typeof value.totalQuestions === 'number' &&
      Array.isArray(value.replies) &&
      value.replies.every(
        (r) => isRecord(r) && typeof r.questionIndex === 'number' && typeof r.text === 'string',
      )
    );
  }
  if (value.status === 'no_reply') return typeof value.reason === 'string';
  return false;
}

function isSettledAsk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.askId === 'string' &&
    typeof value.sessionId === 'string' &&
    isAskResult(value.result) &&
    typeof value.at === 'number'
  );
}

function isPersistedFileShape(value: unknown): value is PersistedFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === 'number' &&
    typeof value.savedAt === 'number' &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isPersistedSession) &&
    Array.isArray(value.pendingAsks) &&
    value.pendingAsks.every(isPendingAsk) &&
    Array.isArray(value.settledAsks) &&
    value.settledAsks.every(isSettledAsk)
  );
}

/** What loadPersistedState hands the caller: the state to restore plus the
 * moment it was saved, so restoreState can shift each session's clocks by
 * the actual downtime rather than resetting them to the restore moment
 * (#116 follow-up). */
export interface LoadedPersistedState {
  state: PersistedStoreState;
  savedAt: number;
}

/**
 * Read and validate the saved sessions file. Never throws: a missing file
 * (the common case, e.g. the first launch on a port) resolves to null with
 * no log; anything that looks like an attempt at the format but fails to
 * fully validate (bad JSON, an unknown version, a shape check failure, or a
 * `savedAt` outside the restore window) resolves to null with exactly one
 * console.warn naming the reason, and the caller starts clean. A partially
 * bad file is rejected as a whole; there is no per-session salvage, since a
 * corrupt file is evidence the whole write may be suspect.
 */
export async function loadPersistedState(
  path: string,
  now: Date,
): Promise<LoadedPersistedState | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[session-persistence] could not read ${path}, starting clean:`, err);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[session-persistence] ${path} is not valid JSON, starting clean:`, err);
    return null;
  }

  if (!isPersistedFileShape(parsed)) {
    console.warn(`[session-persistence] ${path} has an unexpected shape, starting clean`);
    return null;
  }

  if (parsed.version !== PERSISTENCE_VERSION) {
    console.warn(
      `[session-persistence] ${path} has version ${parsed.version}, expected ${PERSISTENCE_VERSION}; starting clean`,
    );
    return null;
  }

  const age = now.getTime() - parsed.savedAt;
  if (age > RESTORE_WINDOW_MS) {
    console.warn(
      `[session-persistence] ${path} is ${Math.round(age / 1000)}s old, past the restore window; starting clean`,
    );
    return null;
  }
  if (age < -FUTURE_SLOP_MS) {
    console.warn(`[session-persistence] ${path} has a savedAt in the future; starting clean`);
    return null;
  }

  return {
    state: {
      sessions: parsed.sessions,
      pendingAsks: parsed.pendingAsks,
      settledAsks: parsed.settledAsks,
    },
    savedAt: parsed.savedAt,
  };
}

function toPersistedFile(state: PersistedStoreState, savedAt: number): PersistedFile {
  return { version: PERSISTENCE_VERSION, savedAt, ...state };
}

export interface SessionSaver {
  /** Debounce a write; coalesces bursts of changes into one write per
   * `debounceMs` of quiet. */
  schedule(): void;
  /** Write the current state right now, synchronously, cancelling any
   * pending debounced write. Used on graceful shutdown, where the process
   * may not survive long enough for an async write (or a setTimeout) to
   * run. Never throws. */
  flushSync(): void;
}

/**
 * Owns writing ReviewSessionStore snapshots to disk. `getState` is called
 * fresh inside every write attempt (sync or async), never cached, so a
 * write always reflects whatever changed most recently as of the moment it
 * actually runs.
 *
 * Async writes are chained on one promise (`chain = chain.then(write,
 * write)`) so two scheduled writes can never race each other or land
 * out of order; passing `write` as both the fulfilled and rejected handler
 * means a failed write does not break the chain for the one after it.
 * `flushSync` bypasses that chain on purpose (it has to complete inside a
 * synchronous `process.on('exit', ...)` handler, where there is no event
 * loop left to await a promise on), so it can run while an async write from
 * an earlier change is still in flight. `seq`/`lastCompletedSeq` are what
 * keep that safe: every write attempt, sync or async, takes a ticket before
 * doing anything else, and an async write skips its own write once it can
 * see a later-numbered one has already completed, and one that finishes
 * after a newer save writes the current state again. That covers a running
 * server. It cannot cover the moment of exit: an async rename already handed
 * to the thread pool can still land after flushSync's and before the process
 * ends, and no JavaScript runs afterwards to correct it. The window is a few
 * milliseconds at shutdown, and the loss is one debounce interval of state.
 */
export function createSessionSaver(opts: {
  path: string;
  getState: () => PersistedStoreState;
  debounceMs?: number;
  /**
   * Test seam: replaces the async write primitive (defaults to
   * atomicWriteFile). A test uses this to hold an async write open long
   * enough to deterministically race a synchronous flushSync against it;
   * production never sets it.
   */
  writeFileAsync?: (path: string, content: string) => Promise<void>;
}): SessionSaver {
  const { path, getState, debounceMs = 250, writeFileAsync = atomicWriteFile } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;
  let lastCompletedSeq = 0;

  async function writeCurrentState(): Promise<void> {
    const payload = toPersistedFile(getState(), Date.now());
    await writeFileAsync(path, JSON.stringify(payload));
    // atomicWriteFile inherits the destination's existing mode (or the
    // temp file's own default when there is none), so the 0600 this file
    // needs (it holds file paths and, in a terminal result, comment text)
    // is set explicitly here rather than relied on. Best effort: chmod is
    // largely a no-op on Windows (see the design doc's edge cases table).
    await chmodAsync(path, 0o600).catch(() => {});
  }

  async function write(): Promise<void> {
    const mySeq = ++seq;
    try {
      await mkdirIfNeeded(dirname(path));
      // A flushSync (or, in principle, a write further down the chain) may
      // already have completed a newer save while this one was getting
      // ready; writing this now-stale snapshot would only rename over it.
      if (mySeq <= lastCompletedSeq) return;
      await writeCurrentState();
      if (mySeq < lastCompletedSeq) {
        // A flushSync finished with newer state while writeCurrentState
        // above was in flight, so the write it just did landed after
        // flushSync's and clobbered it with what is now stale data.
        // Re-render with whatever is current right now rather than leave
        // the file holding something older than the last completed save.
        await writeCurrentState();
        return;
      }
      lastCompletedSeq = mySeq;
    } catch (err) {
      console.warn(`[session-persistence] failed to save sessions to ${path}:`, err);
    }
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        chain = chain.then(write, write);
      }, debounceMs);
      // Don't hold the process open just to flush a debounced write; the
      // shutdown paths (SIGINT/SIGTERM/api-shutdown) call flushSync instead.
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as unknown as { unref: () => void }).unref();
      }
    },

    flushSync() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const mySeq = ++seq;
      try {
        writeSyncNow(path, getState());
        lastCompletedSeq = Math.max(lastCompletedSeq, mySeq);
      } catch (err) {
        // The shutdown path that called this must still exit; losing the
        // last few hundred ms of state is far better than hanging on exit.
        console.warn(`[session-persistence] failed to flush sessions to ${path}:`, err);
      }
    },
  };
}

/**
 * Keeps a live review's saved file from going stale while nothing about it
 * changes: `onChange` only fires on a state mutation, and heartbeats used to
 * be excluded from what gets saved, so an idle review's `savedAt` could sit
 * still for far longer than RESTORE_WINDOW_MS and a crash after that would
 * lose it even though the review was still live. Now that heartbeats ARE
 * saved (see PersistedSession.lastHeartbeatAt), a periodic resave carries a
 * current one onto disk on a fixed cadence, independent of whether anything
 * else changed. `.unref()`'d like the debounce timer: this must never be the
 * reason the process stays alive. Cheap by design: `hasOpenSessions` is
 * meant to be a fast check (e.g. `listOpenSessions().length > 0`), skipped
 * entirely (no `schedule()` call, so no write) whenever nothing is open.
 */
export function startPeriodicSave(opts: {
  saver: Pick<SessionSaver, 'schedule'>;
  hasOpenSessions: () => boolean;
  intervalMs?: number;
}): { stop: () => void } {
  const { saver, hasOpenSessions, intervalMs = 60_000 } = opts;
  const timer = setInterval(() => {
    if (hasOpenSessions()) saver.schedule();
  }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

async function mkdirIfNeeded(dir: string): Promise<void> {
  // A saved session holds file paths and, in a terminal result, the prompt
  // with comment text, so the directory (like the file) is kept private to
  // the user. mkdir's mode option only applies to directories it actually
  // creates, so it does nothing for one that already exists; the explicit
  // chmod after it covers that case too, rather than trusting a directory
  // that predates this feature (or was made by something else) to already
  // be private. Best effort: a failure here must not block the save.
  await mkdirAsync(dir, { recursive: true, mode: 0o700 });
  await chmodAsync(dir, 0o700).catch(() => {});
}

/**
 * Remove leftover `sessions-<port>.json.<random>.tmp` files for this port:
 * a temp file a write created but never got to rename into place, because
 * the process died in between (a SIGKILL mid-save, say). Best effort and
 * scoped to this port's own prefix, so a failure to list or remove one is
 * logged and never stops boot, and this can never touch another port's
 * saves or an unrelated file someone put in the directory.
 */
export async function cleanStaleTempFiles(homeDir: string, port: number): Promise<void> {
  const dir = join(homeDir, '.md-redline');
  const prefix = `sessions-${port}.json.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[session-persistence] could not list ${dir} to clean stale temp files:`, err);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    await unlinkAsync(join(dir, entry)).catch((err) => {
      console.warn(`[session-persistence] could not remove stale temp file ${entry}:`, err);
    });
  }
}

/**
 * The synchronous half of a save, shared by flushSync. Deliberately does not
 * reuse atomicWriteFile (an async API): a graceful-shutdown flush has to
 * complete inside a `process.on('exit', ...)` handler, which Node only runs
 * synchronous code in, so this reimplements the same temp-file-then-rename
 * shape with the sync fs functions instead, wrapped in retryTransientSync
 * (the sync twin of the retry atomicWriteFile already gets) for the same
 * reason atomicWriteFile needs it: on Windows, AV and sync clients bounce a
 * create or a rename while they hold a handle on the path, and that is
 * transient, not a real failure.
 */
function writeSyncNow(path: string, state: PersistedStoreState): void {
  const payload = toPersistedFile(state, Date.now());
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort; see mkdirIfNeeded's async twin for why this matters */
  }
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const content = JSON.stringify(payload);
  try {
    // 'wx' (as atomicWriteFile uses for its own temp file) fails instead of
    // following a symlink planted at tmpPath, rather than writeFileSync's
    // default of creating-or-truncating whatever is already there.
    retryTransientSync(() => writeFileSync(tmpPath, content, { mode: 0o600, flag: 'wx' }));
    retryTransientSync(() => renameSync(tmpPath, path));
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup; the write already failed */
    }
    throw err;
  }
  // Belt and braces: writeFileSync already created the temp file at 0600 and
  // rename preserves mode, so this is normally a no-op. Kept explicit (and
  // best effort) in case a platform's rename or umask behaves otherwise.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort, e.g. a no-op on Windows */
  }
}

/**
 * Wrap a fetch handler so every request waits until `open()` is called. The
 * server listens before it knows its port, and the saved sessions are per
 * port, so without this an agent reconnecting after a restart, or a tab's
 * first heartbeat, could land before the restore, get a 404 for a session
 * about to exist, and give it up for good.
 */
export function holdRequestsUntilOpen<A extends unknown[], R>(
  handler: (...args: A) => R | Promise<R>,
): { fetch: (...args: A) => Promise<R>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return {
    fetch: async (...args: A) => {
      await opened;
      return handler(...args);
    },
    open,
  };
}
