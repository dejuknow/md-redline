import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addTrustedRoot,
  readPreferences,
  readPreferencesSync,
  writePreferences,
} from './preferences';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'md-redline-prefs-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true });
});

beforeEach(async () => {
  // Clean up the prefs file between tests
  try {
    await rm(join(testDir, '.md-redline.json'));
  } catch {
    /* doesn't exist */
  }
  try {
    await rm(join(testDir, '.md-redline.json.tmp'));
  } catch {
    /* doesn't exist */
  }
});

describe('readPreferences', () => {
  it('returns {} when dotfile does not exist', async () => {
    const prefs = await readPreferences(testDir);
    expect(prefs).toEqual({});
  });

  it('returns parsed content when dotfile exists', async () => {
    await writeFile(
      join(testDir, '.md-redline.json'),
      JSON.stringify({ author: 'Alice', theme: 'dark' }),
    );
    const prefs = await readPreferences(testDir);
    expect(prefs).toEqual({ author: 'Alice', theme: 'dark' });
  });

  it('returns {} on invalid JSON', async () => {
    await writeFile(join(testDir, '.md-redline.json'), 'not json at all {{{');
    const prefs = await readPreferences(testDir);
    expect(prefs).toEqual({});
  });

  it('returns {} if file contains a JSON array', async () => {
    await writeFile(join(testDir, '.md-redline.json'), '["not", "an", "object"]');
    const prefs = await readPreferences(testDir);
    expect(prefs).toEqual({});
  });

  it('returns {} if file contains a JSON null', async () => {
    await writeFile(join(testDir, '.md-redline.json'), 'null');
    const prefs = await readPreferences(testDir);
    expect(prefs).toEqual({});
  });
});

describe('writePreferences', () => {
  it('creates file when it does not exist', async () => {
    const result = await writePreferences(testDir, { author: 'Bob' });
    expect(result).toEqual({ author: 'Bob' });

    const raw = await readFile(join(testDir, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.author).toBe('Bob');
  });

  it('merges with existing content', async () => {
    await writePreferences(testDir, { author: 'Alice', theme: 'light' });
    const result = await writePreferences(testDir, { theme: 'dark' });
    expect(result).toEqual({ author: 'Alice', theme: 'dark' });
  });

  it('preserves keys not in the patch', async () => {
    await writePreferences(testDir, {
      author: 'Alice',
      theme: 'dark',
      recentFiles: [{ path: '/a.md', name: 'a.md', openedAt: '2026-01-01T00:00:00Z' }],
    });
    const result = await writePreferences(testDir, { author: 'Bob' });
    expect(result.author).toBe('Bob');
    expect(result.theme).toBe('dark');
    expect(result.recentFiles).toHaveLength(1);
  });

  it('replaces top-level keys entirely (no deep merge)', async () => {
    await writePreferences(testDir, {
      settings: { commentMaxLength: 500, enableResolve: true },
    });
    const result = await writePreferences(testDir, {
      settings: { commentMaxLength: 1000 },
    });
    // enableResolve should be gone — settings was replaced entirely
    expect(result.settings).toEqual({ commentMaxLength: 1000 });
  });

  it('serializes concurrent writes correctly', async () => {
    // Fire multiple writes concurrently
    const promises = [
      writePreferences(testDir, { author: 'A' }),
      writePreferences(testDir, { theme: 'dark' }),
      writePreferences(testDir, { author: 'B' }),
    ];
    await Promise.all(promises);

    const final = await readPreferences(testDir);
    // Both author and theme should be present (all writes completed)
    expect(final.theme).toBe('dark');
    // Author should be either A or B (last write wins), but must exist
    expect(typeof final.author).toBe('string');
  });

  it('writes valid JSON with trailing newline', async () => {
    await writePreferences(testDir, { author: 'Test' });
    const raw = await readFile(join(testDir, '.md-redline.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('round-trips trustedRoots field', async () => {
    await writePreferences(testDir, {
      trustedRoots: ['/Users/test/vault-a', '/Users/test/vault-b'],
    });
    const result = await readPreferences(testDir);
    expect(result.trustedRoots).toEqual([
      '/Users/test/vault-a',
      '/Users/test/vault-b',
    ]);
  });
});

describe('readPreferencesSync', () => {
  it('returns {} when dotfile does not exist', () => {
    expect(readPreferencesSync(testDir)).toEqual({});
  });

  it('returns parsed content when dotfile exists', async () => {
    await writeFile(
      join(testDir, '.md-redline.json'),
      JSON.stringify({ author: 'Sync', trustedRoots: ['/x'] }),
    );
    expect(readPreferencesSync(testDir)).toEqual({
      author: 'Sync',
      trustedRoots: ['/x'],
    });
  });

  it('returns {} on invalid JSON', async () => {
    await writeFile(join(testDir, '.md-redline.json'), 'definitely not json');
    expect(readPreferencesSync(testDir)).toEqual({});
  });

  it('returns {} if file contains a JSON array', async () => {
    await writeFile(join(testDir, '.md-redline.json'), '["array"]');
    expect(readPreferencesSync(testDir)).toEqual({});
  });

  it('returns {} if file contains a JSON null', async () => {
    await writeFile(join(testDir, '.md-redline.json'), 'null');
    expect(readPreferencesSync(testDir)).toEqual({});
  });
});

describe('addTrustedRoot', () => {
  it('adds a new path to an empty list', async () => {
    await addTrustedRoot(testDir, '/Users/test/vault');
    const prefs = await readPreferences(testDir);
    expect(prefs.trustedRoots).toEqual(['/Users/test/vault']);
  });

  it('appends to an existing list', async () => {
    await writePreferences(testDir, { trustedRoots: ['/a'] });
    await addTrustedRoot(testDir, '/b');
    const prefs = await readPreferences(testDir);
    expect(prefs.trustedRoots).toEqual(['/a', '/b']);
  });

  it('does not duplicate when called twice with the same path', async () => {
    await addTrustedRoot(testDir, '/Users/test/vault');
    await addTrustedRoot(testDir, '/Users/test/vault');
    const prefs = await readPreferences(testDir);
    expect(prefs.trustedRoots).toEqual(['/Users/test/vault']);
  });

  it('serializes concurrent calls without race', async () => {
    await Promise.all([
      addTrustedRoot(testDir, '/p1'),
      addTrustedRoot(testDir, '/p2'),
      addTrustedRoot(testDir, '/p3'),
    ]);
    const prefs = await readPreferences(testDir);
    // All three must land; order is the order in which the lock released them.
    expect(prefs.trustedRoots).toHaveLength(3);
    expect(prefs.trustedRoots).toEqual(expect.arrayContaining(['/p1', '/p2', '/p3']));
  });

  it('preserves other preference keys', async () => {
    await writePreferences(testDir, { author: 'Alice', theme: 'dark' });
    await addTrustedRoot(testDir, '/x');
    const prefs = await readPreferences(testDir);
    expect(prefs.author).toBe('Alice');
    expect(prefs.theme).toBe('dark');
    expect(prefs.trustedRoots).toEqual(['/x']);
  });
});
