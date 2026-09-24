/**
 * Saves and restores ReviewSessionStore state across a server restart (#116).
 *
 * This module owns serialize, deserialize, file I/O and the write debounce,
 * so review-sessions.ts stays pure and testable (exportState/restoreState do
 * no I/O of their own). See the "Storage" and "When it writes" sections of
 * the design doc for the shape on disk and the write cadence this
 * implements.
 */
import { chmod as chmodAsync, mkdir as mkdirAsync, readFile } from 'fs/promises';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteFile } from './fs-retry';
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
): Promise<PersistedStoreState | null> {
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
    sessions: parsed.sessions,
    pendingAsks: parsed.pendingAsks,
    settledAsks: parsed.settledAsks,
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
 * fresh on every write (sync or debounced), never cached, so a write always
 * reflects whatever changed most recently.
 */
export function createSessionSaver(opts: {
  path: string;
  getState: () => PersistedStoreState;
  debounceMs?: number;
}): SessionSaver {
  const { path, getState, debounceMs = 250 } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function writeAsync(): Promise<void> {
    const payload = toPersistedFile(getState(), Date.now());
    const dir = dirname(path);
    await mkdirIfNeeded(dir);
    await atomicWriteFile(path, JSON.stringify(payload));
    // atomicWriteFile inherits the destination's existing mode (or the
    // temp file's own default when there is none), so the 0600 this file
    // needs (it holds file paths and, in a terminal result, comment text)
    // is set explicitly here rather than relied on. Best effort: chmod is
    // largely a no-op on Windows (see the design doc's edge cases table).
    await chmodAsync(path, 0o600).catch(() => {});
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void writeAsync().catch((err) => {
          console.warn(`[session-persistence] failed to save sessions to ${path}:`, err);
        });
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
      try {
        writeSyncNow(path, getState());
      } catch (err) {
        // The shutdown path that called this must still exit; losing the
        // last few hundred ms of state is far better than hanging on exit.
        console.warn(`[session-persistence] failed to flush sessions to ${path}:`, err);
      }
    },
  };
}

async function mkdirIfNeeded(dir: string): Promise<void> {
  // A saved session holds file paths and, in a terminal result, the prompt
  // with comment text, so the directory (like the file) is kept private to
  // the user. mkdir's mode option only applies to directories it actually
  // creates, which is exactly the case this guards: an existing directory
  // is left with whatever mode it already had.
  await mkdirAsync(dir, { recursive: true, mode: 0o700 });
}

/**
 * The synchronous half of a save, shared by flushSync. Deliberately does not
 * reuse atomicWriteFile (an async API): a graceful-shutdown flush has to
 * complete inside a `process.on('exit', ...)` handler, which Node only runs
 * synchronous code in, so this reimplements the same temp-file-then-rename
 * shape with the sync fs functions instead.
 */
function writeSyncNow(path: string, state: PersistedStoreState): void {
  const payload = toPersistedFile(state, Date.now());
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmpPath, path);
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
