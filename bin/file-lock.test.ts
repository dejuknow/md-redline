import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import {
  acquireFileLock,
  LOCK_MAX_WAIT_MS,
  LOCK_STALE_MS,
  LOCK_SUFFIX,
  LockContentionError,
} from './file-lock.js';

// The lock had no direct test: every assertion on it ran through
// server/preferences.test.ts, so its invariants held only where preferences
// happened to reach them. The one below about a stolen lock did not.

// Fails a syscall the way an unwritable or unreadable lock path does. Hoisted
// because vi.mock factories run before the module body, and scoped to `.lock`
// so arming one never catches the test's own bookkeeping on another path.
// vi.spyOn cannot do this job: an ESM namespace object is not configurable.
const fault = vi.hoisted(() => ({
  unlink: { failuresLeft: 0, code: 'EPERM' },
  readFile: { failuresLeft: 0, code: 'EIO' },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const faulted = (code: string, call: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: simulated failure, ${call}`), { code });
  return {
    ...actual,
    unlink: async (path: string) => {
      if (fault.unlink.failuresLeft > 0 && String(path).endsWith(LOCK_SUFFIX)) {
        fault.unlink.failuresLeft -= 1;
        throw faulted(fault.unlink.code, `unlink '${path}'`);
      }
      return actual.unlink(path);
    },
    readFile: async (path: string, encoding: BufferEncoding) => {
      if (fault.readFile.failuresLeft > 0 && String(path).endsWith(LOCK_SUFFIX)) {
        fault.readFile.failuresLeft -= 1;
        throw faulted(fault.readFile.code, `read '${path}'`);
      }
      return actual.readFile(path, encoding);
    },
  };
});

let dir: string;
let target: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdr-lock-'));
  target = join(dir, '.md-redline.json');
  lockPath = `${target}${LOCK_SUFFIX}`;
});

afterEach(async () => {
  fault.unlink.failuresLeft = 0;
  fault.readFile.failuresLeft = 0;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Backdate the lock so the staleness branch treats its holder as crashed. */
async function makeStale(path: string): Promise<void> {
  const past = new Date(Date.now() - LOCK_STALE_MS * 2);
  await utimes(path, past, past);
}

describe('acquireFileLock', () => {
  it('creates the lock beside the file and removes it on release', async () => {
    const release = await acquireFileLock(target);
    expect(existsSync(lockPath)).toBe(true);

    await release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('writes the holding pid, which is what makes an abandoned lock diagnosable', async () => {
    const release = await acquireFileLock(target);
    const contents = await readFile(lockPath, 'utf-8');
    expect(contents.split(/\s/)[0]).toBe(String(process.pid));
    await release();
  });

  it('serializes two holders: the second waits for the first to release', async () => {
    const order: string[] = [];
    const first = await acquireFileLock(target);

    const second = acquireFileLock(target).then((release) => {
      order.push('second-acquired');
      return release;
    });

    // Long enough that the waiter has run several attempts and is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual([]);

    order.push('first-released');
    await first();
    await (
      await second
    )();

    expect(order).toEqual(['first-released', 'second-acquired']);
  });

  it('steals a lock left behind by a crashed holder', async () => {
    await writeFile(lockPath, '999999');
    await makeStale(lockPath);

    const release = await acquireFileLock(target);
    expect(await readFile(lockPath, 'utf-8')).toContain(String(process.pid));
    await release();
  });

  it(
    'gives up with LockContentionError while a fresh lock stays put',
    async () => {
      await writeFile(lockPath, '999999');

      await expect(acquireFileLock(target)).rejects.toThrow(LockContentionError);
      // The lock it could not take is still the other holder's, untouched.
      expect(await readFile(lockPath, 'utf-8')).toBe('999999');
    },
    5_000 + LOCK_MAX_WAIT_MS,
  );

  it('release is quiet when the lock is already gone', async () => {
    const release = await acquireFileLock(target);
    await rm(lockPath);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(release()).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports a release it could not perform, because an orphan blocks every writer', async () => {
    const release = await acquireFileLock(target);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every attempt inside retryTransient, so the release exhausts its budget.
    fault.unlink.failuresLeft = Number.MAX_SAFE_INTEGER;

    await release();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(lockPath),
      expect.objectContaining({ code: 'EPERM' }),
    );
  });
});

describe('a lock stolen out from under its holder', () => {
  // The scenario: a holder stalls past LOCK_STALE_MS (the machine suspends, a
  // cloud mount hydrates the file), a second writer reads the stale mtime and
  // steals the lock, and then the first one finishes and releases. Releasing by
  // path alone unlinked the SECOND holder's lock, and from there nothing in the
  // system held mutual exclusion while a writer believed it did.
  it('is not deleted by the original holder on release', async () => {
    const stalled = await acquireFileLock(target);
    await makeStale(lockPath);

    const stealer = await acquireFileLock(target);
    const stolenToken = await readFile(lockPath, 'utf-8');

    await stalled();

    expect(existsSync(lockPath)).toBe(true);
    expect(await readFile(lockPath, 'utf-8')).toBe(stolenToken);

    // And the real holder can still release its own.
    await stealer();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('cannot be released by a holder whose own lock was replaced', async () => {
    const stalled = await acquireFileLock(target);
    await makeStale(lockPath);
    const stealer = await acquireFileLock(target);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await stalled();

    // Never silent: a writer that has lost mutual exclusion has to be able to
    // find out why the file it wrote came back different.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(lockPath));
    await stealer();
  });

  it('leaves the lock alone when ownership cannot be established', async () => {
    const release = await acquireFileLock(target);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A read that fails permanently proves nothing about who holds the lock.
    // Unlinking on that evidence is the very defect above; orphaning ours costs
    // one stale window and clears on its own.
    fault.readFile.failuresLeft = Number.MAX_SAFE_INTEGER;

    await release();

    expect(existsSync(lockPath)).toBe(true);
    expect(consoleError).toHaveBeenCalled();
  });

  it(
    'does not steal a lock that is merely old but still being held',
    async () => {
      // Staleness is decided on mtime, so a holder that refreshes nothing looks
      // dead the moment it crosses the threshold. What must NOT happen is a steal
      // of a lock that is inside the window.
      const release = await acquireFileLock(target);
      const before = await stat(lockPath);
      await expect(acquireFileLock(target)).rejects.toThrow(LockContentionError);
      const after = await stat(lockPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      await release();
    },
    5_000 + LOCK_MAX_WAIT_MS,
  );
});

// An interrupt between acquiring and the caller's `finally` used to leave the
// lock on disk, which wedges every writer of that file (this process, another
// mdr, the server) until it ages out 30 seconds later. `mdr --restrict` is the
// shortest path to it: one Ctrl-C in a window the user cannot see.
//
// Driven as real child processes because there is no in-process seam for a
// signal: the handler under test is the one Node installs on the process, and
// the exit status it produces is half of what the fix has to preserve.
describe('an interrupt while the lock is held', () => {
  const lockModule = pathToFileURL(join(__dirname, 'file-lock.js')).href;

  interface Child {
    kill: (signal: NodeJS.Signals) => void;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  }

  /** Start a child that acquires the lock, prints `ready`, and waits. */
  async function holdLockInChild(body = ''): Promise<Child> {
    const source = `
      import { acquireFileLock } from ${JSON.stringify(lockModule)};
      ${body}
      const release = await acquireFileLock(${JSON.stringify(target)});
      globalThis.__release = release;
      console.log('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ready')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`child exited early: ${stderr}`)));
    });

    return {
      kill: (signal) => child.kill(signal),
      exited: new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
      }),
    };
  }

  // On Windows there is no signal to deliver: child.kill() there is a
  // TerminateProcess, which no handler can intercept. A real Ctrl-C in a
  // console still reaches Node as a SIGINT event and still runs the cleanup
  // below; it is only this way of provoking it that cannot exist.
  const itPosix = it.skipIf(process.platform === 'win32');

  itPosix('removes the lock instead of leaving it to age out', async () => {
    const child = await holdLockInChild();
    expect(existsSync(lockPath)).toBe(true);

    child.kill('SIGINT');
    await child.exited;

    expect(existsSync(lockPath)).toBe(false);
  });

  itPosix('still dies the way an uninterrupted Ctrl-C does', async () => {
    // Handling a signal replaces Node's default disposition, so a cleanup
    // handler that forgets to re-raise turns Ctrl-C into a hang or into the
    // wrong exit status for every script that checks it.
    const child = await holdLockInChild();
    child.kill('SIGINT');

    expect((await child.exited).signal).toBe('SIGINT');
  });

  itPosix('cleans up on SIGTERM too', async () => {
    const child = await holdLockInChild();
    child.kill('SIGTERM');
    const { signal } = await child.exited;

    expect(signal).toBe('SIGTERM');
    expect(existsSync(lockPath)).toBe(false);
  });

  itPosix("defers to the process's own handler rather than exiting under it", async () => {
    // The server's shape: it already handles SIGINT and exits itself. Our
    // cleanup has to run without taking that decision away from it, which is
    // also the only path where process.exit runs instead of a signal death.
    const child = await holdLockInChild(`
      process.on('SIGINT', () => { console.error('server handler ran'); process.exit(3); });
    `);
    child.kill('SIGINT');
    const { code, signal, stderr } = await child.exited;

    expect(stderr).toContain('server handler ran');
    expect(code).toBe(3);
    expect(signal).toBe(null);
    expect(existsSync(lockPath)).toBe(false);
  });

  itPosix('leaves a lock that was stolen while the process stalled', async () => {
    const child = await holdLockInChild();
    await makeStale(lockPath);
    const stealer = await acquireFileLock(target);
    const stolenToken = await readFile(lockPath, 'utf-8');

    child.kill('SIGINT');
    await child.exited;

    expect(await readFile(lockPath, 'utf-8')).toBe(stolenToken);
    await stealer();
  });

  itPosix('keeps handling signals until the lock is actually gone', async () => {
    // The window between "release started" and "lock file removed". Forgetting
    // the lock at the top of release empties the held set, which uninstalls
    // every handler, while the read and unlink that follow are async. A Ctrl-C
    // in there found nothing installed and stranded the lock for the full stale
    // window, which is the failure this module exists to prevent, arriving
    // through release instead of through acquire.
    const source = `
      import { acquireFileLock } from ${JSON.stringify(lockModule)};
      import { chmod } from 'fs/promises';
      const release = await acquireFileLock(${JSON.stringify(target)});
      // Make the unlink fail so the release stays open, and report what a
      // signal arriving right now would find.
      await chmod(${JSON.stringify(dir)}, 0o500);
      const pending = release();
      await new Promise((r) => setImmediate(r));
      console.log(JSON.stringify({
        sigint: process.listenerCount('SIGINT'),
        exit: process.listenerCount('exit'),
      }));
      await chmod(${JSON.stringify(dir)}, 0o700);
      await pending.catch(() => {});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    await new Promise((resolvePromise) => child.once('close', resolvePromise));

    expect(JSON.parse(stdout)).toEqual({ sigint: 1, exit: 1 });
  });

  itPosix('stops handling signals once the lock is released', async () => {
    // Cleanup that outlives the lock changes how the process dies for reasons
    // unrelated to the lock, and a listener nothing removes is a leak in a
    // server that writes preferences on every boot and every settings change.
    const source = `
      import { acquireFileLock } from ${JSON.stringify(lockModule)};
      const release = await acquireFileLock(${JSON.stringify(target)});
      await release();
      console.log(JSON.stringify({
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
        exit: process.listenerCount('exit'),
      }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ sigint: 0, sigterm: 0, exit: 0 });
  });
});
