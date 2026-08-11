import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  atomicWriteFile,
  isTransientFsError,
  retryTransient,
  retryTransientSync,
} from './fs-retry';

// Fault injection scoped to a filename suffix, so arming one never catches an
// unrelated call on another path. Hoisted because vi.mock factories run before
// the module body.
const fault = vi.hoisted(() => ({
  rename: {
    failuresLeft: 0,
    code: 'EPERM',
    attempts: 0,
    /** Perform the real move, then report failure, as a filter driver can. */
    commitAnyway: false,
    /** Delete the temp file while reporting failure, as a sync client can. */
    stealTmp: false,
  },
  open: { failuresLeft: 0, code: 'ENOSPC' },
  // Faults the temp file's write/close, AFTER the temp file exists, which is
  // what makes the cleanup assertions non-vacuous.
  write: { failuresLeft: 0, code: 'ENOSPC' },
  close: { failuresLeft: 0, code: 'EIO' },
}));

function faultError(code: string, detail: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated failure, ${detail}`);
  err.code = code;
  return err;
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (!from.endsWith('.tmp')) return actual.rename(from, to);
      fault.rename.attempts += 1;
      if (fault.rename.failuresLeft > 0) {
        fault.rename.failuresLeft -= 1;
        // A filter driver can report a failure for a move that took effect.
        if (fault.rename.commitAnyway) await actual.rename(from, to);
        else if (fault.rename.stealTmp) await actual.unlink(from).catch(() => {});
        throw faultError(fault.rename.code, `rename '${from}'`);
      }
      return actual.rename(from, to);
    },
    open: async (path: string, flags: string) => {
      if (fault.open.failuresLeft > 0 && path.endsWith('.tmp')) {
        fault.open.failuresLeft -= 1;
        throw faultError(fault.open.code, `open '${path}'`);
      }
      const handle = await actual.open(path, flags);
      if (!path.endsWith('.tmp')) return handle;
      // Only writeFile and close are used on the temp handle, so a thin stand-in
      // is enough and keeps the real handle available for cleanup.
      return {
        writeFile: async (content: string, encoding: BufferEncoding) => {
          if (fault.write.failuresLeft > 0) {
            fault.write.failuresLeft -= 1;
            throw faultError(fault.write.code, `write '${path}'`);
          }
          return handle.writeFile(content, encoding);
        },
        close: async () => {
          await handle.close();
          if (fault.close.failuresLeft > 0) {
            fault.close.failuresLeft -= 1;
            throw faultError(fault.close.code, `close '${path}'`);
          }
        },
      };
    },
  };
});

let testDir: string;
let docPath: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'md-redline-fs-retry-'));
  docPath = join(testDir, 'doc.md');
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  fault.rename = {
    failuresLeft: 0,
    code: 'EPERM',
    attempts: 0,
    commitAnyway: false,
    stealTmp: false,
  };
  fault.open = { failuresLeft: 0, code: 'ENOSPC' };
  fault.write = { failuresLeft: 0, code: 'ENOSPC' };
  fault.close = { failuresLeft: 0, code: 'EIO' };
  for (const entry of await readdir(testDir).catch(() => [] as string[])) {
    await rm(join(testDir, entry), { force: true }).catch(() => {});
  }
});

describe('isTransientFsError', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('treats %s as transient', (code) => {
    expect(isTransientFsError(faultError(code, 'x'))).toBe(true);
  });

  it.each(['EXDEV', 'ENOSPC', 'ENOENT'])('treats %s as permanent', (code) => {
    expect(isTransientFsError(faultError(code, 'x'))).toBe(false);
  });

  it('treats an error with no code as permanent', () => {
    expect(isTransientFsError(new Error('plain'))).toBe(false);
  });
});

describe('retryTransient', () => {
  it('returns the value once a transient failure clears', async () => {
    let calls = 0;
    const value = await retryTransient(async () => {
      calls += 1;
      if (calls < 3) throw faultError('EBUSY', 'busy');
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after exactly 5 attempts and rethrows the last error', async () => {
    let calls = 0;
    const op = async () => {
      calls += 1;
      throw faultError('EPERM', `attempt ${calls}`);
    };
    await expect(retryTransient(op)).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(5);
  });

  it('does not retry a permanent error', async () => {
    let calls = 0;
    const op = async () => {
      calls += 1;
      throw faultError('ENOSPC', 'full');
    };
    await expect(retryTransient(op)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(calls).toBe(1);
  });
});

describe('retryTransientSync', () => {
  it('returns the value once a transient failure clears', () => {
    let calls = 0;
    const value = retryTransientSync(() => {
      calls += 1;
      if (calls < 3) throw faultError('EACCES', 'denied');
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a permanent error', () => {
    let calls = 0;
    expect(() =>
      retryTransientSync(() => {
        calls += 1;
        throw faultError('ENOENT', 'missing');
      }),
    ).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });
});

describe('atomicWriteFile', () => {
  it('writes content and leaves no temp file', async () => {
    await atomicWriteFile(docPath, '# hello\n');

    expect(await readFile(docPath, 'utf-8')).toBe('# hello\n');
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing file through a bounced rename', async () => {
    // Overwriting an existing destination is the case Windows bounces: the
    // scanner holds the file the user just had open, not the temp file.
    await writeFile(docPath, 'old\n');
    fault.rename.failuresLeft = 3;

    await atomicWriteFile(docPath, 'new\n');

    expect(await readFile(docPath, 'utf-8')).toBe('new\n');
    expect(fault.rename.attempts).toBe(4);
  });

  it('removes the temp file when the rename never succeeds', async () => {
    await writeFile(docPath, 'old\n');
    fault.rename.failuresLeft = Number.MAX_SAFE_INTEGER;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'EPERM' });

    // The user's document must survive a failed save untouched...
    expect(await readFile(docPath, 'utf-8')).toBe('old\n');
    // ...and no temp file may be left in the folder they browse and commit.
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the temp file when the write itself fails', async () => {
    // The fault must fire AFTER the temp file exists, or the assertion below
    // holds whether or not the cleanup code is there at all.
    fault.write.failuresLeft = 1;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the temp file when opening it fails', async () => {
    fault.open.failuresLeft = 1;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('reports the write error, not the close error that follows it', async () => {
    // close surfaces deferred write errors, so it fires on the way out of a
    // failed write. Reporting its code instead would send a permanent ENOSPC
    // down the transient path, or vice versa.
    fault.write.failuresLeft = 1;
    fault.close.failuresLeft = 1;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('fails the write when only close fails, and keeps the destination intact', async () => {
    await writeFile(docPath, 'old\n');
    fault.close.failuresLeft = 1;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(docPath, 'utf-8')).toBe('old\n');
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a rename that landed despite reporting failure as a success', async () => {
    // rename is not idempotent: the retry would otherwise find its source gone
    // and report ENOENT for a save that is correctly on disk.
    await writeFile(docPath, 'old\n');
    fault.rename.failuresLeft = 1;
    fault.rename.commitAnyway = true;

    await atomicWriteFile(docPath, 'new\n');

    expect(await readFile(docPath, 'utf-8')).toBe('new\n');
    expect(fault.rename.attempts).toBe(2);
  });

  it('still fails when the temp file vanishes without the content landing', async () => {
    // Same ENOENT-on-retry shape, but the destination does NOT hold what we
    // wrote, so reporting success would silently lose the user's save.
    await writeFile(docPath, 'old\n');
    fault.rename.failuresLeft = 1;
    fault.rename.stealTmp = true;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(docPath, 'utf-8')).toBe('old\n');
  });

  it('does not retry a permanent rename failure', async () => {
    fault.rename.failuresLeft = 1;
    fault.rename.code = 'EXDEV';

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'EXDEV' });
    expect(fault.rename.attempts).toBe(1);
  });
});
