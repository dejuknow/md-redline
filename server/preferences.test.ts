import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addTrustedRoot,
  readPreferences,
  readPreferencesSync,
  sanitizePreferencesPatch,
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
  // Clean up the prefs file and any quarantined / lock siblings between tests
  const entries = await readdir(testDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith('.md-redline.json')) {
      await rm(join(testDir, entry), { force: true }).catch(() => {});
    }
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

describe('corrupted prefs quarantine', () => {
  it('moves an unparseable prefs file aside instead of overwriting it', async () => {
    // Seed a corrupt file directly
    const prefsFile = join(testDir, '.md-redline.json');
    await writeFile(prefsFile, '{ this is not json');

    // The next write must NOT silently obliterate the corrupt content. The
    // implementation moves the corrupt file to a `.corrupt-<ts>` sibling.
    await writePreferences(testDir, { author: 'Recovered' });

    const entries = await readdir(testDir);
    const quarantined = entries.find(
      (e) => e.startsWith('.md-redline.json.corrupt-') && !e.endsWith('.tmp'),
    );
    expect(quarantined).toBeDefined();

    // The quarantined file still has the original (broken) bytes.
    const recovered = await readFile(join(testDir, quarantined!), 'utf-8');
    expect(recovered).toBe('{ this is not json');

    // And the new prefs file is a valid JSON object containing only the patch.
    const fresh = await readPreferences(testDir);
    expect(fresh).toEqual({ author: 'Recovered' });
  });

  it('quarantines a structurally-wrong prefs file (array)', async () => {
    const prefsFile = join(testDir, '.md-redline.json');
    await writeFile(prefsFile, '["not", "an", "object"]');

    await writePreferences(testDir, { theme: 'dark' });

    const entries = await readdir(testDir);
    expect(
      entries.some(
        (e) => e.startsWith('.md-redline.json.corrupt-') && !e.endsWith('.tmp'),
      ),
    ).toBe(true);

    const fresh = await readPreferences(testDir);
    expect(fresh).toEqual({ theme: 'dark' });
  });

  it('does not quarantine a healthy prefs file', async () => {
    await writePreferences(testDir, { author: 'Healthy' });
    await writePreferences(testDir, { theme: 'dark' });

    const entries = await readdir(testDir);
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(false);

    const final = await readPreferences(testDir);
    expect(final).toEqual({ author: 'Healthy', theme: 'dark' });
  });
});

describe('cross-process file lock', () => {
  it('blocks a second writer until the first releases the lock', async () => {
    // Simulate another process holding the lock by manually creating the
    // lockfile. The next writePreferences call should block until we
    // remove it (or until the stale-lock timeout fires, but the test
    // releases the lock well before then).
    const lockPath = join(testDir, '.md-redline.json.lock');
    await writeFile(lockPath, 'fake-pid');

    let completed = false;
    const writePromise = writePreferences(testDir, { author: 'Locked' }).then(
      (result) => {
        completed = true;
        return result;
      },
    );

    // Give the writer a chance to attempt the lock and back off.
    await new Promise((res) => setTimeout(res, 100));
    expect(completed).toBe(false);

    // Release the foreign lock; the writer should now succeed.
    await rm(lockPath);
    const result = await writePromise;
    expect(completed).toBe(true);
    expect(result).toEqual({ author: 'Locked' });

    // Lock file is gone after the write completes.
    const entries = await readdir(testDir);
    expect(entries.some((e) => e.endsWith('.lock'))).toBe(false);
  });

  it('drops unknown top-level keys from PUT bodies', async () => {
    // Mimic an HTTP body with a mix of known and unknown fields. The sanitizer
    // should silently drop the junk and persist only what matches the schema.
    const result = await writePreferences(testDir, {
      author: 'Alice',
      maliciousKey: { foo: 'bar' },
      __proto__: { polluted: true },
    } as Record<string, unknown>);
    expect(result).toEqual({ author: 'Alice' });
    expect((result as Record<string, unknown>).maliciousKey).toBeUndefined();
    // Confirm Object.prototype was not polluted (object spread does not
    // trigger __proto__ setters per ES spec, but verify regardless).
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops wrong-typed fields per key', async () => {
    const result = await writePreferences(testDir, {
      author: 12345, // wrong type
      theme: 'dark', // valid
      trustedRoots: ['/a', 7, '/b'], // mixed
    } as Record<string, unknown>);
    expect(result).toEqual({ theme: 'dark', trustedRoots: ['/a', '/b'] });
  });

  it('sanitizes nested settings.templates entries', async () => {
    const result = await writePreferences(testDir, {
      settings: {
        templates: [
          { label: 'good', text: 'ok' },
          { label: 'bad', text: 999 },
          'string-not-object',
          null,
        ],
        commentMaxLength: 'not-a-number',
        enableResolve: true,
        unknownSetting: 'drop me',
      },
    } as Record<string, unknown>);
    expect(result.settings).toEqual({
      templates: [{ label: 'good', text: 'ok' }],
      enableResolve: true,
    });
  });

  it('preserves mermaidFullscreenPanelCollapsed through the whitelist', async () => {
    const result = await writePreferences(testDir, {
      settings: {
        mermaidFullscreenPanelCollapsed: true,
        unknownSetting: 'drop me',
      },
    } as Record<string, unknown>);
    expect(result.settings).toEqual({ mermaidFullscreenPanelCollapsed: true });
  });

  it('sanitizePreferencesPatch returns {} for non-object input', () => {
    expect(sanitizePreferencesPatch(null)).toEqual({});
    expect(sanitizePreferencesPatch('hello')).toEqual({});
    expect(sanitizePreferencesPatch([1, 2, 3])).toEqual({});
    expect(sanitizePreferencesPatch(undefined)).toEqual({});
  });

  it('steals an abandoned (stale) lock file', async () => {
    const lockPath = join(testDir, '.md-redline.json.lock');
    await writeFile(lockPath, 'crashed-pid');
    // Backdate the lock so it looks abandoned (older than LOCK_STALE_MS=30s).
    const ancient = Date.now() / 1000 - 60;
    const { utimes } = await import('fs/promises');
    await utimes(lockPath, ancient, ancient);

    const result = await writePreferences(testDir, { author: 'Steal' });
    expect(result).toEqual({ author: 'Steal' });
  });
});
