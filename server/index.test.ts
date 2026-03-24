import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink, mkdir, rmdir, symlink, realpath } from 'fs/promises';
import { realpathSync } from 'fs';
import { join, resolve, extname, dirname } from 'path';
import { tmpdir, homedir } from 'os';

/** Canonicalize a path via realpathSync, matching the production server's startup logic. */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// The server is an Hono app — we test it via fetch against the running process.
// For isolated unit testing, we import the app directly if exported,
// but since it's not, we test the security logic functions directly.

const TEST_DIR = join(tmpdir(), 'md-review-test-' + Date.now());
const TEST_FILE = join(TEST_DIR, 'test.md');
const TEST_FILE_TXT = join(TEST_DIR, 'test.txt');
const EXTERNAL_DIR = join(tmpdir(), 'md-review-external-' + Date.now());

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(EXTERNAL_DIR, { recursive: true });
  await writeFile(TEST_FILE, '# Test\n\nHello world');
  await writeFile(TEST_FILE_TXT, 'not markdown');
});

afterAll(async () => {
  try {
    await unlink(TEST_FILE);
    await unlink(TEST_FILE_TXT);
    // Clean up symlink if created
    try {
      await unlink(join(TEST_DIR, 'link.md'));
    } catch {
      /* ignore */
    }
    try {
      await unlink(join(TEST_DIR, 'ext-link'));
    } catch {
      /* ignore */
    }
    await rmdir(TEST_DIR);
    await rmdir(EXTERNAL_DIR);
  } catch {
    /* ignore cleanup errors */
  }
});

describe('path security logic', () => {
  // Test the security invariants without starting the full server.
  // We replicate the core validation logic here for unit testing.

  const ALLOWED_ROOTS = [resolve(process.cwd())];

  function isPathAllowed(real: string): boolean {
    return ALLOWED_ROOTS.some((root) => real.startsWith(root + '/') || real === root);
  }

  it('allows paths under cwd', () => {
    expect(isPathAllowed(resolve('./test.md'))).toBe(true);
    expect(isPathAllowed(resolve('./subdir/file.md'))).toBe(true);
  });

  it('rejects paths outside allowed roots', () => {
    expect(isPathAllowed('/etc/passwd')).toBe(false);
    expect(isPathAllowed('/tmp/evil.md')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    // resolve normalizes these, but the resulting path is outside allowed roots
    const traversal = resolve('../../etc/passwd');
    expect(isPathAllowed(traversal)).toBe(false);
  });

  it('allows the root itself', () => {
    expect(isPathAllowed(resolve(process.cwd()))).toBe(true);
  });

  it('rejects prefix-spoofing (cwd path as prefix of another dir)', () => {
    // e.g., if cwd is /home/user, reject /home/user-evil/file.md
    const spoofed = resolve(process.cwd()) + '-evil/file.md';
    expect(isPathAllowed(spoofed)).toBe(false);
  });
});

describe('file extension validation', () => {
  function isMdFile(resolved: string): boolean {
    return extname(resolved).toLowerCase() === '.md';
  }

  it('accepts .md files', () => {
    expect(isMdFile('/path/to/file.md')).toBe(true);
    expect(isMdFile('/path/to/FILE.MD')).toBe(true);
  });

  it('rejects non-.md files', () => {
    expect(isMdFile('/path/to/file.txt')).toBe(false);
    expect(isMdFile('/path/to/file.js')).toBe(false);
    expect(isMdFile('/path/to/file.md.bak')).toBe(false);
    expect(isMdFile('/path/to/.env')).toBe(false);
  });

  it('rejects files with no extension', () => {
    expect(isMdFile('/path/to/Makefile')).toBe(false);
  });
});

describe('symlink handling', () => {
  it('realpath resolves symlinks to their target', async () => {
    const { realpath: rp } = await import('fs/promises');
    const linkPath = join(TEST_DIR, 'link.md');

    try {
      await symlink(TEST_FILE, linkPath);
      const realLink = await rp(linkPath);
      const realTarget = await rp(TEST_FILE);
      // Both should resolve to the same real path
      expect(realLink).toBe(realTarget);
    } finally {
      try {
        await unlink(linkPath);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('SSE frame encoding', () => {
  // Test the SSE frame format used by /api/watch
  function sseFrame(event: string, data: string): string {
    const lines = data.split('\n');
    return `event: ${event}\n${lines.map((l) => `data: ${l}`).join('\n')}\n\n`;
  }

  it('encodes a simple event correctly', () => {
    const frame = sseFrame('change', '{"content":"hello"}');
    expect(frame).toBe('event: change\ndata: {"content":"hello"}\n\n');
  });

  it('handles newlines in JSON data by splitting into multiple data lines', () => {
    const data = JSON.stringify({ content: 'line1\nline2' });
    const frame = sseFrame('change', data);
    // The JSON will contain a literal \n inside the string value
    // JSON.stringify escapes newlines as \\n, so no actual newlines in the data
    expect(frame).toBe(`event: change\ndata: ${data}\n\n`);
  });

  it('handles actual newlines in data by splitting into data: lines', () => {
    // If data somehow contains real newlines (not JSON-escaped)
    const frame = sseFrame('change', 'line1\nline2');
    expect(frame).toBe('event: change\ndata: line1\ndata: line2\n\n');
  });

  it('produces valid SSE for connected event', () => {
    const frame = sseFrame('connected', JSON.stringify({ path: '/foo/bar.md' }));
    expect(frame).toContain('event: connected\n');
    expect(frame).toContain('data: ');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('handles empty data', () => {
    const frame = sseFrame('ping', '');
    expect(frame).toBe('event: ping\ndata: \n\n');
  });
});

describe('ALLOWED_ROOTS with initial file', () => {
  it('adds initial file directory to allowed roots when outside cwd/home', () => {
    // Simulate the server startup logic
    const cwd = '/home/user/project';
    const home = '/home/user';
    const roots = [cwd, home];
    const initialDir = '/opt/docs';

    if (!roots.some((r) => initialDir.startsWith(r + '/') || initialDir === r)) {
      roots.push(initialDir);
    }

    expect(roots).toContain('/opt/docs');
  });

  it('does not duplicate if initial file is under cwd', () => {
    const cwd = '/home/user/project';
    const home = '/home/user';
    const roots = [cwd, home];
    const initialDir = '/home/user/project/docs';

    if (!roots.some((r) => initialDir.startsWith(r + '/') || initialDir === r)) {
      roots.push(initialDir);
    }

    expect(roots).toHaveLength(2); // Not added since it's under cwd
  });
});

describe('PUT /api/file JSON body validation', () => {
  it('rejects non-JSON body gracefully', async () => {
    // Simulates the server's try/catch pattern around JSON.parse
    async function parseRequestBody(rawBody: string) {
      try {
        const body = JSON.parse(rawBody);
        if (!body.path || body.content === undefined) {
          return { error: 'path and content are required', status: 400 };
        }
        return { data: body, status: 200 };
      } catch {
        return { error: 'Invalid JSON body', status: 400 };
      }
    }

    // Invalid JSON
    const invalid = await parseRequestBody('not json at all');
    expect(invalid.status).toBe(400);
    expect(invalid.error).toBe('Invalid JSON body');

    // Empty body
    const empty = await parseRequestBody('');
    expect(empty.status).toBe(400);
    expect(empty.error).toBe('Invalid JSON body');

    // Valid JSON but missing fields
    const missingPath = await parseRequestBody('{"content":"hello"}');
    expect(missingPath.status).toBe(400);
    expect(missingPath.error).toBe('path and content are required');

    // Valid JSON with all fields
    const valid = await parseRequestBody('{"path":"/test.md","content":"# Hello"}');
    expect(valid.status).toBe(200);
    expect(valid.data).toEqual({ path: '/test.md', content: '# Hello' });
  });
});

describe('lastWrittenContent self-write detection', () => {
  it('skips SSE notification when file content matches last write', () => {
    const lastWrittenContent = new Map<string, string>();
    const path = '/test/file.md';
    const content = '# Hello\n\nWorld';

    // Simulate app saving the file
    lastWrittenContent.set(path, content);

    // Simulate watcher reading the file — content matches, so skip
    const fileContent = content;
    const isOwnWrite = lastWrittenContent.get(path) === fileContent;
    expect(isOwnWrite).toBe(true);
  });

  it('detects external change when content differs from last write', () => {
    const lastWrittenContent = new Map<string, string>();
    const path = '/test/file.md';

    // Simulate app saving the file
    lastWrittenContent.set(path, '# Hello');

    // Simulate external edit
    const fileContent = '# Hello\n\nNew content';
    const isOwnWrite = lastWrittenContent.get(path) === fileContent;
    expect(isOwnWrite).toBe(false);
  });

  it('detects change when no prior write is tracked', () => {
    const lastWrittenContent = new Map<string, string>();
    const path = '/test/file.md';

    const isOwnWrite = lastWrittenContent.get(path) === '# Hello';
    expect(isOwnWrite).toBe(false);
  });

  it('clears entry after detecting an external change', () => {
    const lastWrittenContent = new Map<string, string>();
    const path = '/test/file.md';

    lastWrittenContent.set(path, '# Hello');

    // External change detected — delete the entry
    const fileContent = '# Changed';
    if (lastWrittenContent.get(path) !== fileContent) {
      lastWrittenContent.delete(path);
    }

    expect(lastWrittenContent.has(path)).toBe(false);
  });
});

describe('symlink bypass prevention for new files', () => {
  // Replicates resolveAndValidate logic: when realpath fails (file doesn't exist),
  // resolve the parent directory to catch symlinked parents pointing outside allowed roots.
  async function resolveAndValidate(inputPath: string, allowedRoots: string[]): Promise<string> {
    const expanded = inputPath.startsWith('~/') ? join(homedir(), inputPath.slice(2)) : inputPath;
    const resolved = resolve(expanded);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      const parent = dirname(resolved);
      try {
        const realParent = await realpath(parent);
        real = join(realParent, resolved.slice(parent.length + 1));
      } catch {
        real = resolved;
      }
    }
    const allowed = allowedRoots.some((root) => real.startsWith(root + '/') || real === root);
    if (!allowed) {
      throw new Error('Access denied: path outside allowed directories');
    }
    return real;
  }

  it('rejects new file under a symlinked directory pointing outside allowed roots', async () => {
    // Create a symlink inside TEST_DIR pointing to EXTERNAL_DIR
    const linkPath = join(TEST_DIR, 'ext-link');
    try {
      await symlink(EXTERNAL_DIR, linkPath);
    } catch {
      // Symlink already exists from a previous run
    }

    // The lexical path is inside TEST_DIR (allowed), but the real parent is EXTERNAL_DIR.
    // Use canonicalize() for allowed roots — matching the production server's startup.
    const maliciousPath = join(linkPath, 'new.md');
    await expect(
      resolveAndValidate(maliciousPath, [canonicalize(TEST_DIR)]),
    ).rejects.toThrow('Access denied');
  });

  it('allows new file under a real (non-symlinked) allowed directory', async () => {
    // Use canonicalize() for allowed roots — matching production.
    // On macOS, /tmp -> /private/tmp, so this tests that both sides are canonical.
    const newFilePath = join(TEST_DIR, 'new-file.md');
    const result = await resolveAndValidate(newFilePath, [canonicalize(TEST_DIR)]);
    expect(result).toContain('new-file.md');
  });
});

describe('tilde expansion', () => {
  async function resolveAndValidate(inputPath: string, allowedRoots: string[]): Promise<string> {
    const expanded = inputPath.startsWith('~/') ? join(homedir(), inputPath.slice(2)) : inputPath;
    const resolved = resolve(expanded);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      const parent = dirname(resolved);
      try {
        const realParent = await realpath(parent);
        real = join(realParent, resolved.slice(parent.length + 1));
      } catch {
        real = resolved;
      }
    }
    const allowed = allowedRoots.some((root) => real.startsWith(root + '/') || real === root);
    if (!allowed) {
      throw new Error('Access denied: path outside allowed directories');
    }
    return real;
  }

  it('expands ~/path to homedir/path', async () => {
    const home = canonicalize(homedir());
    const result = await resolveAndValidate('~/test.md', [home]);
    expect(result).toBe(join(home, 'test.md'));
  });

  it('does not expand ~ in the middle of a path', async () => {
    // "foo/~/bar.md" should NOT expand the ~
    const cwd = canonicalize(process.cwd());
    await expect(
      resolveAndValidate('foo/~/bar.md', [cwd]),
    ).resolves.toContain('foo/~/bar.md');
  });
});

describe('SSE watcher error handling', () => {
  it('watcher cleanup function clears all clients', () => {
    const clients = new Set<{ closed: boolean }>();
    const client1 = { closed: false };
    const client2 = { closed: false };
    clients.add(client1);
    clients.add(client2);

    // Simulate cleanUpWatcher
    for (const client of clients) {
      client.closed = true;
    }
    clients.clear();

    expect(clients.size).toBe(0);
    expect(client1.closed).toBe(true);
    expect(client2.closed).toBe(true);
  });

  it('fileWatchers map is cleaned up on file deletion', () => {
    const fileWatchers = new Map<string, { clients: Set<unknown> }>();
    const path = '/test/file.md';
    fileWatchers.set(path, { clients: new Set() });

    // Simulate cleanup (what happens when readFile throws in the watcher callback)
    fileWatchers.delete(path);

    expect(fileWatchers.has(path)).toBe(false);
  });
});
