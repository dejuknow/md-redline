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
  rename: { failuresLeft: 0, code: 'EPERM', attempts: 0 },
  open: { failuresLeft: 0, code: 'ENOSPC' },
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
        throw faultError(fault.rename.code, `rename '${from}'`);
      }
      return actual.rename(from, to);
    },
    open: async (path: string, flags: string) => {
      if (fault.open.failuresLeft > 0 && path.endsWith('.tmp')) {
        fault.open.failuresLeft -= 1;
        throw faultError(fault.open.code, `open '${path}'`);
      }
      return actual.open(path, flags);
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
  fault.rename = { failuresLeft: 0, code: 'EPERM', attempts: 0 };
  fault.open = { failuresLeft: 0, code: 'ENOSPC' };
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
    fault.open.failuresLeft = 1;

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await readdir(testDir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('does not retry a permanent rename failure', async () => {
    fault.rename.failuresLeft = 1;
    fault.rename.code = 'EXDEV';

    await expect(atomicWriteFile(docPath, 'new\n')).rejects.toMatchObject({ code: 'EXDEV' });
    expect(fault.rename.attempts).toBe(1);
  });
});
