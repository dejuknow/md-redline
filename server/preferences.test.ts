import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readPreferences, writePreferences } from './preferences';

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
  } catch { /* doesn't exist */ }
  try {
    await rm(join(testDir, '.md-redline.json.tmp'));
  } catch { /* doesn't exist */ }
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
});
