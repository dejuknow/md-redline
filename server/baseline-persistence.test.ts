import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  baselineFileName,
  baselinesDirPath,
  createBaselinePersister,
  loadPersistedBaselines,
} from './baseline-persistence';
import { BaselineStore, type Baseline } from './baselines';
import { RESTORE_WINDOW_MS } from './session-persistence';
import { atomicWriteFile } from './fs-retry';

const scratch: string[] = [];

function makeDir(): string {
  const home = mkdtempSync(join(tmpdir(), 'mdr-baselines-'));
  scratch.push(home);
  return baselinesDirPath(home, 7441);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) {
    if (existsSync(join(dir, 'baselines-7441', 'state.json'))) {
      chmodSync(join(dir, 'baselines-7441', 'state.json'), 0o600);
    }
    await rm(dir, { recursive: true, force: true });
  }
});

function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** A store wired to a persister over `dir`, the way a running server has it. */
function wired(dir: string, now?: () => number) {
  const store = new BaselineStore(now ? { now } : {});
  const persister = createBaselinePersister({ dir });
  store.setListener(persister);
  return { store, persister };
}

async function saveThroughStore(dir: string, paths: string[]): Promise<BaselineStore> {
  const { store, persister } = wired(dir);
  for (const path of paths) store.set({ path, content: `before ${path}`, agentName: 'Claude' });
  await persister.idle();
  return store;
}

function readState(dir: string): { savedAt: number; files: string[] } {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

function setSavedAt(dir: string, savedAt: number): void {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...readState(dir), savedAt }));
}

function copyFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n !== 'state.json');
}

describe('saving agent before copies (#138)', () => {
  it('a copy saved by one server comes back in the next, content and all', async () => {
    const dir = makeDir();
    const before = await saveThroughStore(dir, ['/docs/a.md', '/docs/b.md']);

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.path).sort()).toEqual(['/docs/a.md', '/docs/b.md']);
    expect(loaded.find((b) => b.path === '/docs/a.md')).toEqual(before.get('/docs/a.md'));
  });

  it('a replaced copy leaves only the newer file behind', async () => {
    const dir = makeDir();
    let t = 1_000;
    const { store, persister } = wired(dir, () => t);
    store.set({ path: '/a.md', content: 'v1' });
    await persister.idle();
    t = 2_000;
    store.set({ path: '/a.md', content: 'v2' });
    await persister.idle();

    expect(copyFiles(dir)).toEqual([baselineFileName({ path: '/a.md', capturedAt: 2_000 })]);
    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.content)).toEqual(['v2']);
  });

  it('an exit right after a capture still saves it, never the copy it replaced', async () => {
    // Reported: capture, recapture, SIGTERM at once, and the restart brought
    // back the first capture as if it were the latest.
    const dir = makeDir();
    let t = Date.now() - 10_000;
    const { store, persister } = wired(dir, () => t);
    store.set({ path: '/a.md', content: 'v1' });
    await persister.idle();
    t += 1_000;
    store.set({ path: '/a.md', content: 'v2' });
    persister.flushSync();

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.content)).toEqual(['v2']);
  });

  it('a failed overwrite loses the copy rather than vouching for the older one', async () => {
    quiet();
    const dir = makeDir();
    let t = Date.now() - 10_000;
    const { store, persister } = wired(dir, () => t);
    store.set({ path: '/a.md', content: 'v1' });
    await persister.idle();
    t += 1_000;
    // A directory where the new file should go makes its write fail.
    mkdirSync(join(dir, baselineFileName({ path: '/a.md', capturedAt: t })));
    store.set({ path: '/a.md', content: 'v2' });
    await persister.idle();

    expect(await loadPersistedBaselines(dir, new Date())).toEqual([]);
  });

  it('takes the old copy off the list before the new one is written', async () => {
    // A crash between the two writes must lose the copy, not restore the
    // older one in its place.
    const dir = makeDir();
    let t = Date.now() - 10_000;
    const listedWhenCopyWritten: string[][] = [];
    const store = new BaselineStore({ now: () => t });
    const persister = createBaselinePersister({
      dir,
      writeFileAsync: async (file, content) => {
        if (!file.endsWith('state.json')) {
          const stateFile = join(dir, 'state.json');
          listedWhenCopyWritten.push(existsSync(stateFile) ? readState(dir).files : []);
        }
        await atomicWriteFile(file, content);
      },
    });
    store.setListener(persister);
    store.set({ path: '/a.md', content: 'v1' });
    await persister.idle();
    const v1 = readState(dir).files[0];
    t += 1_000;
    store.set({ path: '/a.md', content: 'v2' });
    await persister.idle();

    // Nothing listed when v1 was written, and v1 already gone from the list
    // when v2 was.
    expect(v1).toBeDefined();
    expect(listedWhenCopyWritten).toEqual([[], []]);
  });

  it('an exit while a batch is being written still saves the whole batch', async () => {
    const dir = makeDir();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const store = new BaselineStore();
    const persister = createBaselinePersister({
      dir,
      writeFileAsync: async (file, content) => {
        if (flushed && file.endsWith('state.json')) lateStateWrites += 1;
        if (!file.endsWith('state.json')) await held;
        await atomicWriteFile(file, content);
      },
    });
    let flushed = false;
    let lateStateWrites = 0;
    store.setListener(persister);
    store.set({ path: '/a.md', content: 'a' });
    store.set({ path: '/b.md', content: 'b' });
    // Let the drain start and park on its first copy write.
    await new Promise((r) => setTimeout(r, 20));
    persister.flushSync();
    flushed = true;
    release();
    await persister.idle();
    // The parked drain finishes its copy writes but never rewrites the list
    // the flush just wrote.
    expect(lateStateWrites).toBe(0);

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.path).sort()).toEqual(['/a.md', '/b.md']);
  });

  it('a copy whose write failed is retried by the next touch', async () => {
    quiet();
    const dir = makeDir();
    let fail = true;
    const store = new BaselineStore();
    const persister = createBaselinePersister({
      dir,
      writeFileAsync: async (file, content) => {
        if (fail && !file.endsWith('state.json')) throw new Error('disk full');
        await atomicWriteFile(file, content);
      },
    });
    store.setListener(persister);
    store.set({ path: '/a.md', content: 'a' });
    await persister.idle();
    expect(await loadPersistedBaselines(dir, new Date())).toEqual([]);

    fail = false;
    persister.touch();
    await persister.idle();
    expect((await loadPersistedBaselines(dir, new Date())).map((b) => b.path)).toEqual(['/a.md']);
  });

  it('no async write starts after the exit flush', async () => {
    const dir = makeDir();
    const writes: string[] = [];
    const store = new BaselineStore();
    const persister = createBaselinePersister({
      dir,
      writeFileAsync: async (file, content) => {
        writes.push(file);
        await atomicWriteFile(file, content);
      },
    });
    store.setListener(persister);
    store.set({ path: '/a.md', content: 'a' });
    persister.flushSync();
    persister.touch();
    await persister.idle();
    expect(writes).toEqual([]);
    expect(await loadPersistedBaselines(dir, new Date())).toHaveLength(1);
  });

  it('never restores a copy removed right after it was stored', async () => {
    const dir = makeDir();
    const { store, persister } = wired(dir);
    store.set({ path: '/a.md', content: 'a' });
    persister.removed('/a.md');
    await persister.idle();
    expect(await loadPersistedBaselines(dir, new Date())).toEqual([]);
  });

  it('removing the last copy leaves no directory behind', async () => {
    const dir = makeDir();
    const { store, persister } = wired(dir);
    store.set({ path: '/a.md', content: 'a' });
    await persister.idle();
    expect(existsSync(dir)).toBe(true);
    persister.removed('/a.md');
    await persister.idle();
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps each file private to the user', async () => {
    if (process.platform === 'win32') return;
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('the restore window (#138)', () => {
  it('restores copies from a server last seen just inside the window', async () => {
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md']);
    const savedAt = Date.now();
    setSavedAt(dir, savedAt);
    const loaded = await loadPersistedBaselines(dir, new Date(savedAt + RESTORE_WINDOW_MS));
    expect(loaded).toHaveLength(1);
  });

  it('starts clean, and deletes the copies, past the window', async () => {
    quiet();
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md', '/b.md']);
    const savedAt = Date.now();
    setSavedAt(dir, savedAt);

    const loaded = await loadPersistedBaselines(dir, new Date(savedAt + RESTORE_WINDOW_MS + 1));
    expect(loaded).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('starts clean when the save time is missing or in the future', async () => {
    quiet();
    const missing = makeDir();
    await saveThroughStore(missing, ['/a.md']);
    await rm(join(missing, 'state.json'));
    expect(await loadPersistedBaselines(missing, new Date())).toEqual([]);

    const future = makeDir();
    await saveThroughStore(future, ['/a.md']);
    setSavedAt(future, Date.now() + 60_000);
    expect(await loadPersistedBaselines(future, new Date())).toEqual([]);
  });

  it('a copy the list does not name is deleted, however fresh the list is', async () => {
    // A file that outlived a failed delete must not come back just because a
    // later capture wrote a fresh state.json.
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md']);
    const stray: Baseline = { path: '/old.md', content: 'x', capturedAt: 5, bytes: 1 };
    const strayName = baselineFileName(stray);
    writeFileSync(join(dir, strayName), JSON.stringify({ version: 1, ...stray }));

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.path)).toEqual(['/a.md']);
    expect(existsSync(join(dir, strayName))).toBe(false);
  });

  it('touch keeps a long-held copy inside the window, and so does the exit flush', async () => {
    const dir = makeDir();
    const { store, persister } = wired(dir);
    store.set({ path: '/a.md', content: 'a' });
    await persister.idle();

    setSavedAt(dir, 0);
    persister.touch();
    await persister.idle();
    expect(await loadPersistedBaselines(dir, new Date())).toHaveLength(1);

    setSavedAt(dir, 0);
    persister.flushSync();
    expect(await loadPersistedBaselines(dir, new Date())).toHaveLength(1);
  });

  it('a restored copy stays vouched for, so its save time keeps being refreshed', async () => {
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md']);
    const { store, persister } = wired(dir);
    store.restore(await loadPersistedBaselines(dir, new Date()));

    setSavedAt(dir, 0);
    persister.touch();
    await persister.idle();
    expect(readState(dir).files).toHaveLength(1);
    expect(await loadPersistedBaselines(dir, new Date())).toHaveLength(1);
  });

  it('touch and the exit flush write nothing when no copies are held', async () => {
    const dir = makeDir();
    const persister = createBaselinePersister({ dir });
    persister.touch();
    persister.flushSync();
    await persister.idle();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('loading what is on disk (#138)', () => {
  it('returns nothing, silently, when there is no directory yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadPersistedBaselines(makeDir(), new Date())).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps every copy on disk when state.json cannot be read', async () => {
    // Reported: an unreadable state.json deleted every valid copy.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    quiet();
    const dir = makeDir();
    await saveThroughStore(dir, ['/a.md', '/b.md']);
    chmodSync(join(dir, 'state.json'), 0o000);

    expect(await loadPersistedBaselines(dir, new Date())).toEqual([]);
    expect(copyFiles(dir)).toHaveLength(2);
  });

  it('removes a listed file that does not parse, or was not written for its own contents', async () => {
    quiet();
    const dir = makeDir();
    await saveThroughStore(dir, ['/good.md']);
    const good = readState(dir).files[0];
    const moved = 'f'.repeat(32) + '-1.json';
    writeFileSync(join(dir, 'garbage.json'), '{not json');
    writeFileSync(join(dir, moved), readFileSync(join(dir, good), 'utf8'));
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ ...readState(dir), files: [good, 'garbage.json', moved] }),
    );

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.path)).toEqual(['/good.md']);
    expect(copyFiles(dir)).toEqual([good]);
  });

  it('rejects a copy stamped in the future, which would never expire', async () => {
    quiet();
    const dir = makeDir();
    const future: Baseline = {
      path: '/f.md',
      content: 'x',
      capturedAt: Date.now() + 30 * 86_400_000,
      bytes: 1,
    };
    const name = baselineFileName(future);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ version: 1, ...future }));
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, savedAt: Date.now(), files: [name] }),
    );

    expect(await loadPersistedBaselines(dir, new Date())).toEqual([]);
    expect(copyFiles(dir)).toEqual([]);
  });

  it('keeps only the newest when two copies of one path are listed', async () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    // Picked so the older file sorts after the newer one by name, and a
    // directory listing hands it over last.
    const older: Baseline = {
      path: '/a.md',
      content: 'old',
      capturedAt: 999_999_999_999,
      bytes: 3,
    };
    const newer: Baseline = {
      path: '/a.md',
      content: 'new',
      capturedAt: 1_000_000_000_000,
      bytes: 3,
    };
    for (const b of [older, newer]) {
      writeFileSync(join(dir, baselineFileName(b)), JSON.stringify({ version: 1, ...b }));
    }
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        savedAt: now,
        files: [baselineFileName(older), baselineFileName(newer)],
      }),
    );

    const loaded = await loadPersistedBaselines(dir, new Date());
    expect(loaded.map((b) => b.content)).toEqual(['new']);
    expect(copyFiles(dir)).toEqual([baselineFileName(newer)]);
  });

  it('clears temp files a write left behind', async () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json.abc123.tmp'), 'partial');
    await loadPersistedBaselines(dir, new Date());
    expect(existsSync(dir)).toBe(false);
  });
});
