import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PersistedSession, PersistedStoreState } from './review-sessions';
import {
  cleanStaleTempFiles,
  createSessionSaver,
  holdRequestsUntilOpen,
  loadPersistedState,
  sessionsFilePath,
  startPeriodicSave,
} from './session-persistence';

// Fault injection for writeSyncNow's Windows-transient-error retry (#116,
// fix 5): scoped to a `.tmp` path so it only ever catches the write this
// module's own temp-file-then-rename dance makes, never an unrelated
// writeFileSync elsewhere in this file's other tests. Hoisted because
// vi.mock factories run before top-level `let`/`const` declarations exist.
const fault = vi.hoisted(() => ({
  writeFileSync: { failuresLeft: 0, code: 'EBUSY' as string },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [target] = args;
      if (
        typeof target === 'string' &&
        target.endsWith('.tmp') &&
        fault.writeFileSync.failuresLeft > 0
      ) {
        fault.writeFileSync.failuresLeft -= 1;
        const err: NodeJS.ErrnoException = new Error(`simulated ${fault.writeFileSync.code}`);
        err.code = fault.writeFileSync.code;
        throw err;
      }
      return actual.writeFileSync(...args);
    },
  };
});

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'md-redline-session-persistence-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  fault.writeFileSync = { failuresLeft: 0, code: 'EBUSY' };
  vi.restoreAllMocks();
});

function emptyState(): PersistedStoreState {
  return { sessions: [], pendingAsks: [], settledAsks: [] };
}

/** A fully-populated persisted session, matching PersistedSession's on-disk
 * shape field for field, so the round-trip tests exercise every branch of
 * loadPersistedState's shape check rather than just the fields JSON happens
 * to fill in. */
function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: 'rev_abc',
    filePaths: ['/a.md'],
    originalFilePaths: ['/a.md'],
    fileAddedAt: { '/a.md': '2026-09-24T00:00:00.000Z' },
    enableResolve: true,
    origin: 'user',
    clientId: 'client-1',
    author: 'Claude',
    createdAt: '2026-09-24T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-24T00:00:02.000Z',
    lastAgentActivityAt: '2026-09-24T00:00:01.000Z',
    status: 'open',
    sentCommentIds: ['c1'],
    waitingForAgent: false,
    waitingForAgentSince: null,
    agentCommentCount: 1,
    sessionDoneAt: null,
    terminalReason: null,
    terminalAt: null,
    terminalResult: null,
    queuedBatch: { commentIds: ['c2'], commentCountsByPath: [['/a.md', 1]] },
    ...overrides,
  };
}

function makeTerminalSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return makeSession({
    status: 'done',
    terminalReason: 'finished',
    terminalAt: '2026-09-24T00:00:02.000Z',
    terminalResult: { status: 'done', prompt: 'address these' },
    queuedBatch: null,
    ...overrides,
  });
}

async function writeRawFile(path: string, body: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(body), 'utf8');
}

describe('sessionsFilePath', () => {
  it('is one JSON file per port, under a .md-redline subdirectory of the home dir', () => {
    expect(sessionsFilePath('/Users/dennis', 6373)).toBe(
      join('/Users/dennis', '.md-redline', 'sessions-6373.json'),
    );
    // Different ports never collide, which is the whole point: two named
    // servers must not read or write each other's reviews.
    expect(sessionsFilePath('/Users/dennis', 6374)).not.toBe(
      sessionsFilePath('/Users/dennis', 6373),
    );
  });
});

describe('loadPersistedState', () => {
  it('returns null and logs nothing for a missing file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadPersistedState(join(testDir, 'sessions-1.json'), new Date());
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('round-trips a full state: open session, terminal session, pending ask, settled ask', async () => {
    const path = join(testDir, 'sessions-1.json');
    const state: PersistedStoreState = {
      sessions: [makeSession(), makeTerminalSession({ id: 'rev_done', origin: 'agent' })],
      pendingAsks: [
        {
          askId: 'ask_1',
          sessionId: 'rev_abc',
          questions: [
            {
              commentId: 'c1',
              filePath: '/a.md',
              anchor: 'context',
              text: 'why this approach?',
              contextBefore: 'before',
              contextAfter: 'after',
            },
          ],
        },
      ],
      settledAsks: [
        {
          askId: 'ask_0',
          sessionId: 'rev_abc',
          result: {
            status: 'reply',
            replies: [{ questionIndex: 0, text: 'because' }],
            totalQuestions: 1,
          },
          at: Date.now(),
        },
      ],
    };

    const now = new Date();
    await writeRawFile(path, { version: 1, savedAt: now.getTime(), ...state });

    const result = await loadPersistedState(path, now);
    expect(result).toEqual({ state, savedAt: now.getTime() });
  });

  it('ignores a file whose savedAt is older than the restore window', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    const now = new Date('2026-09-24T00:10:00.000Z');
    const savedAt = now.getTime() - 6 * 60_000; // 6 minutes old
    await writeRawFile(path, { version: 1, savedAt, ...emptyState() });

    const result = await loadPersistedState(path, now);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('ignores a file whose savedAt is in the future', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    const now = new Date('2026-09-24T00:10:00.000Z');
    const savedAt = now.getTime() + 60_000; // a minute ahead, well past clock slop
    await writeRawFile(path, { version: 1, savedAt, ...emptyState() });

    const result = await loadPersistedState(path, now);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('tolerates a few seconds of clock skew forward', async () => {
    const path = join(testDir, 'sessions-1.json');
    const now = new Date('2026-09-24T00:10:00.000Z');
    const savedAt = now.getTime() + 2_000; // 2s ahead, within the slop budget
    await writeRawFile(path, { version: 1, savedAt, ...emptyState() });

    const result = await loadPersistedState(path, now);
    expect(result).toEqual({ state: emptyState(), savedAt });
  });

  it('ignores a file with an unknown version', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    await writeRawFile(path, { version: 2, savedAt: Date.now(), ...emptyState() });

    const result = await loadPersistedState(path, new Date());
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('ignores corrupt JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    await writeFile(path, '{ not valid json', 'utf8');

    const result = await loadPersistedState(path, new Date());
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('rejects the whole file on a shape check failure, with one warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    // filePaths must be an array; restoreState spreads it, so a string here
    // would throw at restore time if this slipped through. Cast past the
    // type checker deliberately: the point of this fixture is a value the
    // real type never allows, which is exactly what a hand-edited or
    // truncated file on disk could contain.
    const badSession = { ...makeSession(), filePaths: 'not-an-array' as unknown as string[] };
    const badState = { sessions: [badSession], pendingAsks: [], settledAsks: [] };
    await writeRawFile(path, { version: 1, savedAt: Date.now(), ...badState });

    const result = await loadPersistedState(path, new Date());
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('rejects a file whose queuedBatch commentCountsByPath is not [path, count] pairs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testDir, 'sessions-1.json');
    const badSession = {
      ...makeSession(),
      queuedBatch: {
        commentIds: ['c1'],
        commentCountsByPath: [['/a.md', 'not-a-number']] as unknown as [string, number][],
      },
    };
    const badState = { sessions: [badSession], pendingAsks: [], settledAsks: [] };
    await writeRawFile(path, { version: 1, savedAt: Date.now(), ...badState });

    const result = await loadPersistedState(path, new Date());
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('createSessionSaver', () => {
  it('debounce coalesces repeated schedule() calls into a single write', async () => {
    // Real timers rather than fake ones: schedule()'s write is real async fs
    // I/O (mkdir, atomicWriteFile, chmod), and vi.advanceTimersByTimeAsync
    // only pumps the fake clock, not an unrelated chain of real syscalls; it
    // returns before the write actually lands, racing this test's own
    // assertions and afterEach's directory cleanup.
    const path = join(testDir, 'sessions-1.json');
    const getState = vi.fn(emptyState);
    const saver = createSessionSaver({ path, getState, debounceMs: 20 });

    for (let i = 0; i < 10; i++) saver.schedule();
    expect(getState).not.toHaveBeenCalled();

    // Past the debounce window, with slack for the write itself to finish.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(getState).toHaveBeenCalledOnce();
    const written = JSON.parse(await readFile(path, 'utf8'));
    expect(written).toMatchObject({ version: 1, ...emptyState() });
  });

  it('flushSync writes immediately, without waiting for the debounce', () => {
    const path = join(testDir, 'sessions-1.json');
    const state: PersistedStoreState = {
      sessions: [makeSession()],
      pendingAsks: [],
      settledAsks: [],
    };
    const saver = createSessionSaver({ path, getState: () => state, debounceMs: 250 });

    saver.flushSync();

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ version: 1, ...state });
  });

  it('flushSync cancels a pending debounced write instead of racing it', async () => {
    vi.useFakeTimers();
    try {
      const path = join(testDir, 'sessions-1.json');
      const getState = vi.fn(emptyState);
      const saver = createSessionSaver({ path, getState, debounceMs: 250 });

      saver.schedule();
      saver.flushSync();
      expect(getState).toHaveBeenCalledOnce(); // the flushSync call

      await vi.advanceTimersByTimeAsync(250);
      // The debounced timer was cancelled by flushSync, so it must not fire
      // a second write on top of it.
      expect(getState).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when the write fails, so a shutdown can still exit', () => {
    // A path whose parent cannot be created (a file sitting where a
    // directory needs to go) makes mkdirSync fail; flushSync must swallow
    // that rather than propagate it.
    const blockerFile = join(testDir, 'blocker');
    writeFileSync(blockerFile, 'not a directory');
    const path = join(blockerFile, 'nested', 'sessions-1.json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saver = createSessionSaver({ path, getState: emptyState });

    expect(() => saver.flushSync()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('creates the directory at 0700 and the file at 0600 (POSIX only)', () => {
    if (process.platform === 'win32') return;
    const path = join(testDir, 'nested', 'sessions-1.json');
    const saver = createSessionSaver({ path, getState: emptyState });

    saver.flushSync();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(testDir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('chmods a pre-existing, more permissive directory to 0700 too (POSIX only)', () => {
    if (process.platform === 'win32') return;
    const dir = join(testDir, 'nested');
    // mkdir's mode option only takes effect for a directory it actually
    // creates; simulate one that predates this feature (or was made by
    // something else) with a permissive mode already set.
    mkdirSync(dir, { mode: 0o755 });
    const path = join(dir, 'sessions-1.json');
    const saver = createSessionSaver({ path, getState: emptyState });

    saver.flushSync();

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('flushSync retries a transient EBUSY writing the temp file and still succeeds (Windows-only in practice)', () => {
    // EBUSY on the temp-file write is exactly what a Windows AV scanner or
    // sync client bounces a create with; retryTransientSync is what turns
    // that into a short retry instead of an outright failure.
    fault.writeFileSync = { failuresLeft: 2, code: 'EBUSY' };
    const path = join(testDir, 'sessions-1.json');
    const state: PersistedStoreState = {
      sessions: [makeSession()],
      pendingAsks: [],
      settledAsks: [],
    };
    const saver = createSessionSaver({ path, getState: () => state });

    expect(() => saver.flushSync()).not.toThrow();

    expect(fault.writeFileSync.failuresLeft).toBe(0);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ version: 1, ...state });
  });

  it('a slow async write does not clobber a flushSync that lands first', async () => {
    const path = join(testDir, 'sessions-1.json');
    let state: PersistedStoreState = {
      sessions: [makeSession({ id: 'first' })],
      pendingAsks: [],
      settledAsks: [],
    };
    const getState = () => state;

    let releaseSlowWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });
    let asyncWriteCalls = 0;
    const saver = createSessionSaver({
      path,
      getState,
      debounceMs: 5,
      writeFileAsync: async (p, content) => {
        asyncWriteCalls += 1;
        // Held open until the test releases it, so flushSync below runs
        // while this write is still in flight.
        await gate;
        await writeFile(p, content, 'utf8');
      },
    });

    saver.schedule();
    // Let the debounce fire and the async write begin; it is now blocked on
    // the gate, holding the "first" snapshot it captured before the state
    // changed below.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asyncWriteCalls).toBe(1);

    // A newer state lands and is flushed synchronously, simulating a
    // shutdown that interrupts the async write above mid-flight.
    state = { sessions: [makeSession({ id: 'second' })], pendingAsks: [], settledAsks: [] };
    saver.flushSync();
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0].id).toBe('second');

    // Let the slow async write finish; its stale "first" snapshot must not
    // overwrite what flushSync already wrote.
    releaseSlowWrite();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const final = JSON.parse(await readFile(path, 'utf8'));
    expect(final.sessions[0].id).toBe('second');
  });
});

describe('startPeriodicSave (#116)', () => {
  it('schedules a save on the interval only while sessions are open', () => {
    vi.useFakeTimers();
    try {
      const schedule = vi.fn();
      let open = false;
      const { stop } = startPeriodicSave({
        saver: { schedule },
        hasOpenSessions: () => open,
        intervalMs: 1_000,
      });

      vi.advanceTimersByTime(3_000);
      expect(schedule).not.toHaveBeenCalled();

      open = true;
      vi.advanceTimersByTime(3_000);
      expect(schedule).toHaveBeenCalledTimes(3);

      open = false;
      stop();
      vi.advanceTimersByTime(5_000);
      expect(schedule).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cleanStaleTempFiles (#116)', () => {
  it("removes only this port's leftover temp files, leaving other ports and unrelated files alone", async () => {
    const dir = join(testDir, '.md-redline');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sessions-6373.json.abc123.tmp'), '{}', 'utf8');
    await writeFile(join(dir, 'sessions-6373.json.def456.tmp'), '{}', 'utf8');
    await writeFile(join(dir, 'sessions-6374.json.zzz999.tmp'), '{}', 'utf8');
    await writeFile(join(dir, 'sessions-6373.json'), '{}', 'utf8');
    await writeFile(join(dir, 'preferences.json'), '{}', 'utf8');

    await cleanStaleTempFiles(testDir, 6373);

    expect(existsSync(join(dir, 'sessions-6373.json.abc123.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'sessions-6373.json.def456.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'sessions-6374.json.zzz999.tmp'))).toBe(true);
    expect(existsSync(join(dir, 'sessions-6373.json'))).toBe(true);
    expect(existsSync(join(dir, 'preferences.json'))).toBe(true);
  });

  it('never throws when the directory does not exist yet', async () => {
    await expect(
      cleanStaleTempFiles(join(testDir, 'never-created'), 6373),
    ).resolves.toBeUndefined();
  });
});

describe('holdRequestsUntilOpen (#116)', () => {
  it('holds a request made before open, then answers it', async () => {
    let handled = 0;
    const gate = holdRequestsUntilOpen((n: number) => {
      handled += 1;
      return n * 2;
    });
    const pending = gate.fetch(21);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handled).toBe(0);
    gate.open();
    await expect(pending).resolves.toBe(42);
    await expect(gate.fetch(1)).resolves.toBe(2);
  });
});
