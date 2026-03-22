import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink, mkdir, rmdir, symlink } from 'fs/promises';
import { join, resolve, extname } from 'path';
import { tmpdir } from 'os';

// The server is an Hono app — we test it via fetch against the running process.
// For isolated unit testing, we import the app directly if exported,
// but since it's not, we test the security logic functions directly.

const TEST_DIR = join(tmpdir(), 'md-commenter-test-' + Date.now());
const TEST_FILE = join(TEST_DIR, 'test.md');
const TEST_FILE_TXT = join(TEST_DIR, 'test.txt');

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
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
    await rmdir(TEST_DIR);
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
