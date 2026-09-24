import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PersistedSession, PersistedStoreState } from './review-sessions';
import { createSessionSaver, loadPersistedState, sessionsFilePath } from './session-persistence';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'md-redline-session-persistence-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
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
    expect(result).toEqual(state);
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
    expect(result).toEqual(emptyState());
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
});
