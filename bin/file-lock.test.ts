import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
