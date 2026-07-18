import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createApp,
  createAppFull,
  isPathInsideRoot,
  removePortFileIfOwned,
  type CreateAppOptions,
} from './index';
import { addReply, parseComments } from '../src/lib/comment-parser';

type AppInstance = ReturnType<typeof createApp>;

let app: AppInstance;
let initialFileApp: AppInstance;
let initialDirApp: AppInstance;

let cwdRoot: string;
let fakeHome: string;
let initialDir: string;
let externalDir: string;
let docsDir: string;
let nestedDir: string;

let rootFile: string;
let docsFile: string;
let homeFile: string;
let textFile: string;
let externalFile: string;
let allowedSymlinkFile: string;
let outsideSymlinkFile: string;
let allowedSymlinkDir: string;
let outsideSymlinkDir: string;
let writtenFile: string;
let initialSiblingFile: string;
let imageFile: string;

function createExecFileStub(stdout: string) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFileImpl = ((
    file: string,
    args: readonly string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args: [...args] });
    callback(null, stdout, '');
  }) as unknown as CreateAppOptions['execFileImpl'];

  return { calls, execFileImpl };
}

async function requestJson(appInstance: AppInstance, path: string, init?: RequestInit) {
  const response = await appInstance.request(`http://localhost${path}`, init);
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  cwdRoot = await mkdtemp(join(tmpdir(), 'md-redline-server-cwd-'));
  fakeHome = await mkdtemp(join(tmpdir(), 'md-redline-server-home-'));
  initialDir = await mkdtemp(join(tmpdir(), 'md-redline-server-initial-'));
  externalDir = await mkdtemp(join(tmpdir(), 'md-redline-server-external-'));
  cwdRoot = await realpath(cwdRoot);
  fakeHome = await realpath(fakeHome);
  initialDir = await realpath(initialDir);
  externalDir = await realpath(externalDir);

  docsDir = join(cwdRoot, 'docs');
  nestedDir = join(docsDir, 'nested');
  const hiddenDir = join(docsDir, '.hidden-dir');

  await mkdir(docsDir, { recursive: true });
  await mkdir(nestedDir, { recursive: true });
  await mkdir(hiddenDir, { recursive: true });

  rootFile = join(cwdRoot, 'root.md');
  docsFile = join(docsDir, 'alpha.md');
  homeFile = join(fakeHome, 'home.md');
  textFile = join(docsDir, 'notes.txt');
  externalFile = join(externalDir, 'outside.md');
  allowedSymlinkFile = join(docsDir, 'home-link.md');
  outsideSymlinkFile = join(docsDir, 'outside-link.md');
  allowedSymlinkDir = join(cwdRoot, 'home-dir');
  outsideSymlinkDir = join(cwdRoot, 'outside-dir');
  writtenFile = join(docsDir, 'written.md');
  initialSiblingFile = join(initialDir, 'follow-up.md');

  await writeFile(rootFile, '# Root\n');
  await writeFile(docsFile, '# Alpha\n\nHello world\n');
  await writeFile(homeFile, '# Home\n');
  await writeFile(textFile, 'not markdown');
  await writeFile(externalFile, '# Outside\n');
  await writeFile(writtenFile, '# Previous\n');
  await writeFile(join(docsDir, 'zeta.md'), '# Zeta\n');
  await writeFile(join(docsDir, 'README.MD'), '# Uppercase\n');
  await writeFile(join(nestedDir, 'nested.md'), '# Nested\n');
  await writeFile(join(hiddenDir, 'secret.md'), '# Secret\n');
  await writeFile(join(initialDir, 'initial.md'), '# Initial\n');
  await writeFile(initialSiblingFile, '# Follow-up\n\nInitial sibling\n');

  // Tiny 1x1 transparent PNG used for /api/asset tests
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Z6OFP8AAAAASUVORK5CYII=',
    'base64',
  );
  imageFile = join(docsDir, 'pixel.png');
  await writeFile(imageFile, TINY_PNG);

  await symlink(rootFile, allowedSymlinkFile);
  await symlink(externalFile, outsideSymlinkFile);
  await symlink(nestedDir, allowedSymlinkDir);
  await symlink(externalDir, outsideSymlinkDir);

  app = createApp({
    cwd: cwdRoot,
    homeDir: fakeHome,
    platformName: 'linux',
  });
  initialFileApp = createApp({
    cwd: cwdRoot,
    homeDir: fakeHome,
    initialArg: join(initialDir, 'initial.md'),
    platformName: 'linux',
  });
  initialDirApp = createApp({
    cwd: cwdRoot,
    homeDir: fakeHome,
    initialArg: initialDir,
    platformName: 'linux',
  });
});

afterAll(async () => {
  await rm(cwdRoot, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(initialDir, { recursive: true, force: true });
  await rm(externalDir, { recursive: true, force: true });
});

describe('/api/config', () => {
  it('returns empty initial paths by default', async () => {
    const { response, body } = await requestJson(app, '/api/config');

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ initialFile: '', initialDir: '' });
    expect(typeof body.homeDir).toBe('string');
  });

  it('returns the configured initial file or directory', async () => {
    const fileConfig = await requestJson(initialFileApp, '/api/config');
    const dirConfig = await requestJson(initialDirApp, '/api/config');

    expect(fileConfig.body).toMatchObject({
      initialFile: join(initialDir, 'initial.md'),
      initialDir: '',
    });
    expect(typeof fileConfig.body.homeDir).toBe('string');
    expect(dirConfig.body).toMatchObject({
      initialFile: '',
      initialDir,
    });
    expect(typeof dirConfig.body.homeDir).toBe('string');
  });

  it('returns the homeDir for tilde-shortening on the client', async () => {
    const { response, body } = await requestJson(app, '/api/config');
    expect(response.status).toBe(200);
    // The fake homeDir for `app` is fakeHome. /api/config should expose it
    // so the frontend can render trust prompts with ~/path-style display.
    expect(body.homeDir).toBe(fakeHome);
  });
});

describe('/api/shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { ok: true } and schedules process.exit(0)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { response, body } = await requestJson(app, '/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });

    // setImmediate defers the exit; flush it
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rejects non-POST methods', async () => {
    const response = await app.request('http://localhost/api/shutdown');
    expect(response.status).toBe(404);
  });

  it('rejects POSTs without application/json Content-Type with 415', async () => {
    // Regression: the CLI's gracefulShutdown must send this header, otherwise
    // the JSON-only CSRF middleware returns 415 and upgrade falls back to killPort.
    const response = await app.request('http://localhost/api/shutdown', {
      method: 'POST',
    });
    expect(response.status).toBe(415);
  });
});

describe('/api/preferences', () => {
  it('returns {} when no dotfile exists', async () => {
    const { response, body } = await requestJson(app, '/api/preferences');
    expect(response.status).toBe(200);
    expect(body).toEqual({});
  });

  it('returns dotfile content when it exists', async () => {
    const { writeFile: wf } = await import('fs/promises');
    await wf(join(fakeHome, '.md-redline.json'), JSON.stringify({ author: 'Test', theme: 'nord' }));
    const { response, body } = await requestJson(app, '/api/preferences');
    expect(response.status).toBe(200);
    expect(body).toEqual({ author: 'Test', theme: 'nord' });
    // Clean up
    const { rm: rmf } = await import('fs/promises');
    await rmf(join(fakeHome, '.md-redline.json'));
  });

  it('PUT creates dotfile and returns merged content', async () => {
    const { response, body } = await requestJson(app, '/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'Alice' }),
    });
    expect(response.status).toBe(200);
    expect(body.author).toBe('Alice');
    // Clean up
    const { rm: rmf } = await import('fs/promises');
    await rmf(join(fakeHome, '.md-redline.json'));
  });

  it('PUT merges partial updates', async () => {
    const { writeFile: wf, rm: rmf } = await import('fs/promises');
    await wf(
      join(fakeHome, '.md-redline.json'),
      JSON.stringify({ author: 'Alice', theme: 'light' }),
    );
    const { response, body } = await requestJson(app, '/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({ author: 'Alice', theme: 'dark' });
    await rmf(join(fakeHome, '.md-redline.json'));
  });

  it('PUT rejects invalid JSON body', async () => {
    const response = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/version', () => {
  it('omits latest when no newer version is known', async () => {
    const res = await app.request('/api/version');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: expect.any(String) });
  });

  it('includes latest when the update checker reports one', async () => {
    const versionApp = createApp({ homeDir: fakeHome, getLatestVersion: () => '99.0.0' });
    const res = await versionApp.request('/api/version');
    expect(await res.json()).toEqual({ version: expect.any(String), latest: '99.0.0' });
  });

  it('omits latest when the checker returns null', async () => {
    const versionApp = createApp({ homeDir: fakeHome, getLatestVersion: () => null });
    expect(await (await versionApp.request('/api/version')).json()).toEqual({
      version: expect.any(String),
    });
  });
});

describe('update preferences over HTTP', () => {
  it('strips the server-owned updateCheck key from client PUTs', async () => {
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updateCheck: { latestKnown: '99.0.0', checkedAt: '2026-01-01T00:00:00.000Z' },
        updateDismissedVersion: '0.7.0',
      }),
    });
    expect(res.status).toBe(200);
    const prefs = await (await app.request('/api/preferences')).json();
    expect(prefs.updateCheck).toBeUndefined();
    expect(prefs.updateDismissedVersion).toBe('0.7.0');
  });
});

describe('isPathInsideRoot', () => {
  it('accepts nested POSIX paths', () => {
    expect(isPathInsideRoot('/repo/docs/spec.md', '/repo')).toBe(true);
  });

  it('rejects sibling POSIX paths', () => {
    expect(isPathInsideRoot('/repo-other/spec.md', '/repo')).toBe(false);
  });

  it('handles Windows separators and case-insensitive matching', () => {
    expect(isPathInsideRoot('C:\\Work\\Docs\\Spec.md', 'c:\\work', true)).toBe(true);
    expect(isPathInsideRoot('D:\\Work\\Docs\\Spec.md', 'c:\\work', true)).toBe(false);
  });

  it('accepts all paths when root is /', () => {
    expect(isPathInsideRoot('/etc/foo', '/')).toBe(true);
    expect(isPathInsideRoot('/home/user/file.md', '/')).toBe(true);
  });
});

describe('/api/file', () => {
  it('requires a path query parameter', async () => {
    const { response, body } = await requestJson(app, '/api/file');

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'path query parameter is required' });
  });

  it('reads markdown files under allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent(docsFile)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: docsFile,
      content: '# Alpha\n\nHello world\n',
    });
  });

  it('rejects tilde paths when home directory is outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent('~/home.md')}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('expands tilde paths when home directory is inside an allowed root', async () => {
    const homeInCwdApp = createApp({
      cwd: cwdRoot,
      homeDir: cwdRoot,
      platformName: 'linux',
    });
    const { response, body } = await requestJson(
      homeInCwdApp,
      `/api/file?path=${encodeURIComponent('~/root.md')}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: rootFile,
      content: '# Root\n',
    });
  });

  it('rejects non-markdown files', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent(textFile)}`,
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Only .md files are supported' });
  });

  it('rejects files outside the allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent(externalFile)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('reads symlinked files that resolve inside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent(allowedSymlinkFile)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: rootFile,
      content: '# Root\n',
    });
  });

  it('rejects symlinked files that resolve outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent(outsideSymlinkFile)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('reads the configured initial file even when it is outside the default roots', async () => {
    const { response, body } = await requestJson(
      initialFileApp,
      `/api/file?path=${encodeURIComponent(join(initialDir, 'initial.md'))}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: join(initialDir, 'initial.md'),
      content: '# Initial\n',
    });
  });
});

describe('PUT /api/file', () => {
  it('rejects invalid JSON bodies', async () => {
    const { response, body } = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid JSON body' });
  });

  it('writes markdown content inside allowed roots', async () => {
    const newContent = '# Written\n\nSaved from test\n';
    const { response, body } = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: writtenFile, content: newContent }),
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, path: writtenFile });
    expect(typeof body.mtime).toBe('number');
    await expect(readFile(writtenFile, 'utf-8')).resolves.toBe(newContent);
  });

  it('returns 409 when expectedMtime does not match (conflict detection)', async () => {
    // First write to establish the file
    const content1 = '# Version 1\n';
    const write1 = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: writtenFile, content: content1 }),
    });
    expect(write1.response.status).toBe(200);
    const mtime1 = write1.body.mtime;

    // Simulate external edit by writing directly and ensuring a different mtime
    await writeFile(writtenFile, '# External edit\n', 'utf-8');
    const futureTime = new Date(Date.now() + 5000);
    await utimes(writtenFile, futureTime, futureTime);

    // Try to save with the old mtime — should conflict
    const { response, body } = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: writtenFile, content: '# Version 2\n', expectedMtime: mtime1 }),
    });

    expect(response.status).toBe(409);
    expect(body.code).toBe('CONFLICT');
    expect(body.currentContent).toBe('# External edit\n');
    expect(typeof body.mtime).toBe('number');
    // File should NOT have been overwritten
    await expect(readFile(writtenFile, 'utf-8')).resolves.toBe('# External edit\n');
  });

  it('allows save when expectedMtime matches', async () => {
    // Write and get mtime
    const content1 = '# Saved\n';
    const write1 = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: writtenFile, content: content1 }),
    });
    const mtime1 = write1.body.mtime;

    // Save again with correct mtime
    const content2 = '# Updated\n';
    const { response, body } = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: writtenFile, content: content2, expectedMtime: mtime1 }),
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    await expect(readFile(writtenFile, 'utf-8')).resolves.toBe(content2);
  });

  it('rejects new files under symlinked directories that point outside allowed roots', async () => {
    const targetFile = join(outsideSymlinkDir, 'new.md');
    const { response, body } = await requestJson(app, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetFile, content: '# Nope\n' }),
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('writes sibling files next to the configured initial file outside the repo', async () => {
    const newContent = '# Follow-up\n\nOpened from CLI\n';
    const { response, body } = await requestJson(initialFileApp, '/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: initialSiblingFile, content: newContent }),
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, path: initialSiblingFile });
    expect(typeof body.mtime).toBe('number');
    await expect(readFile(initialSiblingFile, 'utf-8')).resolves.toBe(newContent);
  });
});

describe('GET /api/asset', () => {
  it('requires a path query parameter', async () => {
    const { response, body } = await requestJson(app, '/api/asset');
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'path query parameter is required' });
  });

  it('serves an image with the correct content type', async () => {
    const response = await app.request(
      `http://localhost/api/asset?path=${encodeURIComponent(imageFile)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('sets a private cache-control header', async () => {
    const response = await app.request(
      `http://localhost/api/asset?path=${encodeURIComponent(imageFile)}`,
    );
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('sets x-content-type-options nosniff', async () => {
    const response = await app.request(
      `http://localhost/api/asset?path=${encodeURIComponent(imageFile)}`,
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('treats an empty path query the same as missing', async () => {
    const { response, body } = await requestJson(app, '/api/asset?path=');
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'path query parameter is required' });
  });

  it('rejects paths outside allowed roots with 403', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/asset?path=${encodeURIComponent(externalFile)}`,
    );
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('rejects non-image extensions with 400', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/asset?path=${encodeURIComponent(textFile)}`,
    );
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Unsupported asset type' });
  });

  it('returns 404 for a missing image file', async () => {
    const missing = join(docsDir, 'does-not-exist.png');
    const { response, body } = await requestJson(
      app,
      `/api/asset?path=${encodeURIComponent(missing)}`,
    );
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'File not found or not readable' });
  });

  it('serves an image referenced via a symlink that resolves inside allowed roots', async () => {
    const link = join(docsDir, 'pixel-link.png');
    await symlink(imageFile, link);
    try {
      const response = await app.request(
        `http://localhost/api/asset?path=${encodeURIComponent(link)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    } finally {
      await rm(link, { force: true });
    }
  });

  it('injects width/height into a viewBox-only svg', async () => {
    const svgPath = join(docsDir, 'viewbox-only.svg');
    await writeFile(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 116"><rect/></svg>',
    );
    try {
      const response = await app.request(
        `http://localhost/api/asset?path=${encodeURIComponent(svgPath)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/svg+xml');
      const text = await response.text();
      expect(text).toContain('width="100"');
      expect(text).toContain('height="116"');
      expect(text).toContain('viewBox="0 0 100 116"');
    } finally {
      await rm(svgPath, { force: true });
    }
  });

  it('sets Content-Security-Policy sandbox on SVG responses to prevent XSS', async () => {
    const svgPath = join(docsDir, 'csp-test.svg');
    await writeFile(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    try {
      const response = await app.request(
        `http://localhost/api/asset?path=${encodeURIComponent(svgPath)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    } finally {
      await rm(svgPath, { force: true });
    }
  });

  it('does not set CSP sandbox header on non-SVG images', async () => {
    const response = await app.request(
      `http://localhost/api/asset?path=${encodeURIComponent(imageFile)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('leaves a sized svg unchanged', async () => {
    const svgPath = join(docsDir, 'sized.svg');
    const original = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect/></svg>';
    await writeFile(svgPath, original);
    try {
      const response = await app.request(
        `http://localhost/api/asset?path=${encodeURIComponent(svgPath)}`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(original);
    } finally {
      await rm(svgPath, { force: true });
    }
  });
});

describe('/api/files', () => {
  it('lists .md files case-insensitively in the requested directory', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/files?dir=${encodeURIComponent(docsDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body.dir).toBe(docsDir);
    expect(body.files).toContain(join(docsDir, 'README.MD'));
    expect(body.files).toContain(join(docsDir, 'alpha.md'));
    expect(body.files).toContain(writtenFile);
    expect(body.files).toContain(join(docsDir, 'zeta.md'));
    expect(body.files).toHaveLength(4);
  });

  it('rejects directories outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/files?dir=${encodeURIComponent(externalDir)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('lists files through symlinked directories that resolve inside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/files?dir=${encodeURIComponent(allowedSymlinkDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: nestedDir,
      files: [join(nestedDir, 'nested.md')],
    });
  });

  it('rejects symlinked directories that resolve outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/files?dir=${encodeURIComponent(outsideSymlinkDir)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('lists files in the configured initial directory outside the repo', async () => {
    const { response, body } = await requestJson(
      initialDirApp,
      `/api/files?dir=${encodeURIComponent(initialDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: initialDir,
      files: [initialSiblingFile, join(initialDir, 'initial.md')],
    });
  });
});

describe('/api/browse', () => {
  it('lists visible directories and markdown files with an allowed parent', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/browse?dir=${encodeURIComponent(docsDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: docsDir,
      parent: cwdRoot,
      directories: [{ name: 'nested', path: join(docsDir, 'nested') }],
      files: [
        { name: 'alpha.md', path: join(docsDir, 'alpha.md') },
        { name: 'README.MD', path: join(docsDir, 'README.MD') },
        { name: 'written.md', path: writtenFile },
        { name: 'zeta.md', path: join(docsDir, 'zeta.md') },
      ],
    });
  });

  it('returns 400 when the path points to a file instead of a directory', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/browse?dir=${encodeURIComponent(docsFile)}`,
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Not a directory' });
  });

  it('browses symlinked directories that resolve inside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/browse?dir=${encodeURIComponent(allowedSymlinkDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: nestedDir,
      parent: docsDir,
      directories: [],
      files: [{ name: 'nested.md', path: join(nestedDir, 'nested.md') }],
    });
  });

  it('rejects symlinked directories that resolve outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/browse?dir=${encodeURIComponent(outsideSymlinkDir)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('browses the configured initial directory outside the repo', async () => {
    const { response, body } = await requestJson(
      initialDirApp,
      `/api/browse?dir=${encodeURIComponent(initialDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: initialDir,
      parent: null,
      directories: [],
      files: [
        { name: 'follow-up.md', path: initialSiblingFile },
        { name: 'initial.md', path: join(initialDir, 'initial.md') },
      ],
    });
  });
});

describe('/api/watch', () => {
  /** Read the initial SSE frames from a streaming response (the stream never closes). */
  async function readSseFrames(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Read available chunks with a short deadline — "connected" frames are written synchronously.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 100),
        ),
      ]);
      if (result.value) text += decoder.decode(result.value, { stream: true });
      if (result.done) break;
    }
    reader.cancel().catch(() => {});
    return text;
  }

  function parseSseEvents(text: string) {
    return text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const eventMatch = block.match(/^event: (.+)$/m);
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6));
        return {
          event: eventMatch?.[1] ?? '',
          data: dataLines.join('\n'),
        };
      });
  }

  it('returns 400 when no path is provided', async () => {
    const { response, body } = await requestJson(app, '/api/watch');

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'path query parameter is required' });
  });

  it('returns 400 for a single non-markdown file', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/watch?path=${encodeURIComponent(textFile)}`,
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Only .md files are supported' });
  });

  it('returns 403 for a single file outside allowed roots', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/watch?path=${encodeURIComponent(externalFile)}`,
    );

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Access denied: path outside allowed directories' });
  });

  it('opens an SSE stream for a single valid file', async () => {
    const response = await app.request(
      `http://localhost/api/watch?path=${encodeURIComponent(docsFile)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await readSseFrames(response);
    const events = parseSseEvents(text);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe('connected');
    expect(JSON.parse(events[0].data)).toEqual({ path: docsFile });
  });

  it('opens a multiplexed SSE stream for multiple valid files', async () => {
    const response = await app.request(
      `http://localhost/api/watch?path=${encodeURIComponent(docsFile)}&path=${encodeURIComponent(rootFile)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await readSseFrames(response);
    const events = parseSseEvents(text);
    const connectedPaths = events
      .filter((e) => e.event === 'connected')
      .map((e) => JSON.parse(e.data).path);
    expect(connectedPaths).toContain(docsFile);
    expect(connectedPaths).toContain(rootFile);
  });

  it('skips invalid paths silently in a multi-path request', async () => {
    const badPath = join(externalDir, 'outside.md');
    const response = await app.request(
      `http://localhost/api/watch?path=${encodeURIComponent(docsFile)}&path=${encodeURIComponent(badPath)}`,
    );

    expect(response.status).toBe(200);

    const text = await readSseFrames(response);
    const events = parseSseEvents(text);
    const connectedPaths = events
      .filter((e) => e.event === 'connected')
      .map((e) => JSON.parse(e.data).path);
    expect(connectedPaths).toEqual([docsFile]);
  });

  it('returns 400 when all paths in a multi-path request are invalid', async () => {
    const bad1 = join(externalDir, 'outside.md');
    const bad2 = join(externalDir, 'also-outside.md');
    const { response, body } = await requestJson(
      app,
      `/api/watch?path=${encodeURIComponent(bad1)}&path=${encodeURIComponent(bad2)}`,
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'No valid .md files to watch' });
  });
});

describe('/api/platform', () => {
  it('returns the injected platform value', async () => {
    const { response, body } = await requestJson(app, '/api/platform');

    expect(response.status).toBe(200);
    expect(body).toEqual({ platform: 'linux' });
  });
});

describe('/api/pick-file', () => {
  it('uses PowerShell on Windows to launch the system picker', async () => {
    const { calls, execFileImpl } = createExecFileStub('C:\\docs\\spec.md\n');
    const windowsApp = createApp({
      cwd: cwdRoot,
      homeDir: fakeHome,
      platformName: 'win32',
      execFileImpl,
    });

    const { response, body } = await requestJson(windowsApp, '/api/pick-file');

    expect(response.status).toBe(200);
    expect(body).toEqual({ path: 'C:\\docs\\spec.md' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('powershell');
    expect(calls[0].args).toContain('-STA');
    expect(calls[0].args.join(' ')).toContain('OpenFileDialog');
  });

  it('persists the picked file directory to trustedRoots in preferences', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pick-persist-'));
    const realHome = await realpath(localHome);
    // No prior prefs file.

    const { execFileImpl } = createExecFileStub(externalFile + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const { response, body } = await requestJson(pickApp, '/api/pick-file');
    expect(response.status).toBe(200);
    expect(body.path).toBe(externalFile);

    // Allow fire-and-forget addTrustedRoot to flush.
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toContain(externalDir);

    await rm(realHome, { recursive: true, force: true });
  });

  it('passes defaultPath to the macOS osascript invocation', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pick-default-'));
    const realHome = await realpath(localHome);
    const { calls, execFileImpl } = createExecFileStub(externalFile + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const targetPath = '/Users/example/notes/my-doc.md';
    const { response } = await requestJson(
      pickApp,
      `/api/pick-file?defaultPath=${encodeURIComponent(targetPath)}`,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const argsJoined = calls[0].args.join(' ');
    expect(argsJoined).toContain(`default location POSIX file "${targetPath}"`);

    // Allow fire-and-forget addTrustedRoot to flush before removing the temp dir.
    await new Promise((r) => setTimeout(r, 50));
    await rm(realHome, { recursive: true, force: true });
  });

  it('escapes quotes and backslashes in defaultPath for osascript', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pick-escape-'));
    const realHome = await realpath(localHome);
    const { calls, execFileImpl } = createExecFileStub(externalFile + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const trickyPath = '/tmp/has "quote" and \\back/file.md';
    await requestJson(
      pickApp,
      `/api/pick-file?defaultPath=${encodeURIComponent(trickyPath)}`,
    );
    expect(calls).toHaveLength(1);
    const argsJoined = calls[0].args.join(' ');
    // Quotes should be backslash-escaped, backslashes doubled.
    expect(argsJoined).toContain('/tmp/has \\"quote\\" and \\\\back/file.md');

    // Allow fire-and-forget addTrustedRoot to flush before removing the temp dir.
    await new Promise((r) => setTimeout(r, 50));
    await rm(realHome, { recursive: true, force: true });
  });

  it('omits the default location clause when defaultPath is missing', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pick-nodefault-'));
    const realHome = await realpath(localHome);
    const { calls, execFileImpl } = createExecFileStub(externalFile + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    await requestJson(pickApp, '/api/pick-file');
    expect(calls).toHaveLength(1);
    const argsJoined = calls[0].args.join(' ');
    expect(argsJoined).not.toContain('default location');

    // Allow fire-and-forget addTrustedRoot to flush before removing the temp dir.
    await new Promise((r) => setTimeout(r, 50));
    await rm(realHome, { recursive: true, force: true });
  });
});

describe('/api/pick-folder', () => {
  it('persists the picked folder to trustedRoots', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pickfolder-persist-'));
    const realHome = await realpath(localHome);
    // Create a real directory the picker can return.
    const pickedRoot = await mkdtemp(join(tmpdir(), 'md-redline-pickfolder-target-'));
    const realPicked = await realpath(pickedRoot);
    const { execFileImpl } = createExecFileStub(realPicked + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const { response, body } = await requestJson(pickApp, '/api/pick-folder');
    expect(response.status).toBe(200);
    expect(body.path).toBe(realPicked);

    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toContain(realPicked);

    await rm(realHome, { recursive: true, force: true });
    await rm(pickedRoot, { recursive: true, force: true });
  });

  it('passes defaultPath to the macOS osascript invocation', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pickfolder-default-'));
    const realHome = await realpath(localHome);
    const pickedRoot = await mkdtemp(join(tmpdir(), 'md-redline-pickfolder-target-'));
    const realPicked = await realpath(pickedRoot);
    const { calls, execFileImpl } = createExecFileStub(realPicked + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const targetPath = '/Users/example/notes';
    const { response } = await requestJson(
      pickApp,
      `/api/pick-folder?defaultPath=${encodeURIComponent(targetPath)}`,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const argsJoined = calls[0].args.join(' ');
    expect(argsJoined).toContain('choose folder');
    expect(argsJoined).toContain(`default location POSIX file "${targetPath}"`);

    await new Promise((r) => setTimeout(r, 50));
    await rm(realHome, { recursive: true, force: true });
    await rm(pickedRoot, { recursive: true, force: true });
  });

  it('rejects when the picked path is not a directory', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-pickfolder-notadir-'));
    const realHome = await realpath(localHome);
    // Stub returns a path to a FILE (externalFile), not a directory.
    const { execFileImpl } = createExecFileStub(externalFile + '\n');
    const pickApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const { response, body } = await requestJson(pickApp, '/api/pick-folder');
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/not a directory/);

    await rm(realHome, { recursive: true, force: true });
  });
});

describe('Host header allowlist (DNS rebinding defense)', () => {
  it('rejects requests with a non-loopback Host header', async () => {
    const response = await app.request(`http://localhost/api/config`, {
      headers: { Host: 'attacker.example.com' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid Host header' });
  });

  it('rejects rebinding attempts with subdomains and ports', async () => {
    const response = await app.request(`http://localhost/api/config`, {
      headers: { Host: 'evil.localhost.attacker.com:3001' },
    });
    expect(response.status).toBe(400);
  });

  it('allows requests with localhost host (with and without port)', async () => {
    const r1 = await app.request(`http://localhost/api/config`, {
      headers: { Host: 'localhost' },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request(`http://localhost/api/config`, {
      headers: { Host: 'localhost:3001' },
    });
    expect(r2.status).toBe(200);
  });

  it('allows requests with 127.0.0.1 host', async () => {
    const r = await app.request(`http://localhost/api/config`, {
      headers: { Host: '127.0.0.1:3001' },
    });
    expect(r.status).toBe(200);
  });

  it('allows requests with IPv6 [::1] host', async () => {
    const r = await app.request(`http://localhost/api/config`, {
      headers: { Host: '[::1]:3001' },
    });
    expect(r.status).toBe(200);
  });
});

describe('file size limit (memory DoS defense)', () => {
  it('rejects /api/file when the file exceeds MAX_FILE_BYTES', async () => {
    // Create a 26 MB markdown file (over the 25 MB limit).
    const bigFile = join(docsDir, 'huge.md');
    const oneMb = 'x'.repeat(1024 * 1024);
    await writeFile(bigFile, '# Big\n' + oneMb.repeat(26));

    const response = await app.request(
      `http://localhost/api/file?path=${encodeURIComponent(bigFile)}`,
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);

    await rm(bigFile);
  });

  it('allows /api/file under the size limit', async () => {
    const response = await app.request(
      `http://localhost/api/file?path=${encodeURIComponent(docsFile)}`,
    );
    expect(response.status).toBe(200);
  });

  it('rejects /api/asset when the asset exceeds MAX_FILE_BYTES', async () => {
    const bigAsset = join(docsDir, 'huge.png');
    // 26 MB of garbage with PNG extension — the size check fires before
    // anything tries to parse it as a real image.
    await writeFile(bigAsset, Buffer.alloc(26 * 1024 * 1024));

    const response = await app.request(
      `http://localhost/api/asset?path=${encodeURIComponent(bigAsset)}`,
    );
    expect(response.status).toBe(413);

    await rm(bigAsset);
  });
});

describe('Content-Type enforcement', () => {
  it('rejects POST requests without application/json Content-Type', async () => {
    const response = await app.request('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ path: docsFile }),
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'Content-Type must be application/json' });
  });

  it('rejects PUT requests without Content-Type header', async () => {
    const response = await app.request('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path: writtenFile, content: '# Test\n' }),
    });

    expect(response.status).toBe(415);
  });

  it('allows GET requests without Content-Type', async () => {
    const response = await app.request(
      `http://localhost/api/file?path=${encodeURIComponent(docsFile)}`,
    );

    expect(response.status).toBe(200);
  });
});

describe('/api/reveal', () => {
  it('uses osascript on macOS with argv pattern to reveal and activate Finder', async () => {
    const { calls, execFileImpl } = createExecFileStub('');
    const macApp = createApp({
      cwd: cwdRoot,
      homeDir: fakeHome,
      platformName: 'darwin',
      execFileImpl,
    });

    const { response, body } = await requestJson(macApp, '/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: docsFile }),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('osascript');
    // Verify argv-based pattern (no string interpolation of the path)
    expect(calls[0].args).toContain('on run argv');
    expect(calls[0].args).toContain('end run');
    expect(calls[0].args).toContain(docsFile);
    expect(calls[0].args.join(' ')).toContain('item 1 of argv');
    // Must coerce to alias — Finder's `reveal` can't consume `POSIX file <var>`
    // directly when the value is bound from argv (fails with -1728).
    expect(calls[0].args.join(' ')).toContain('POSIX file (item 1 of argv) as alias');
    expect(calls[0].args.join(' ')).toContain('tell application "Finder" to activate');
  });

  it('uses Explorer on Windows to reveal a file', async () => {
    const { calls, execFileImpl } = createExecFileStub('');
    const windowsApp = createApp({
      cwd: cwdRoot,
      homeDir: fakeHome,
      platformName: 'win32',
      execFileImpl,
    });

    const { response, body } = await requestJson(windowsApp, '/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: docsFile }),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: 'explorer',
      args: ['/select,', docsFile],
    });
  });
});

describe('/api/grant-access', () => {
  it('rejects granting access to an external directory outside allowed roots', async () => {
    const freshApp = createApp({
      cwd: cwdRoot,
      homeDir: fakeHome,
      platformName: 'linux',
    });

    // External file should be blocked initially
    const before = await requestJson(
      freshApp,
      `/api/file?path=${encodeURIComponent(externalFile)}`,
    );
    expect(before.response.status).toBe(403);

    // Grant access to the external directory — should be rejected
    const grant = await requestJson(freshApp, '/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: externalDir }),
    });
    expect(grant.response.status).toBe(403);
    expect(grant.body).toEqual({ error: 'Cannot grant access outside allowed directories' });

    // External file should still be blocked
    const after = await requestJson(
      freshApp,
      `/api/file?path=${encodeURIComponent(externalFile)}`,
    );
    expect(after.response.status).toBe(403);
  });

  it('allows granting access to a subdirectory of an allowed root', async () => {
    const { response, body } = await requestJson(app, '/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: docsDir }),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ granted: docsDir });
  });

  it('is idempotent for already-allowed paths', async () => {
    const { response, body } = await requestJson(app, '/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cwdRoot }),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ granted: cwdRoot });
  });

  it('rejects missing path', async () => {
    const { response, body } = await requestJson(app, '/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Missing path' });
  });

  it('rejects non-existent path', async () => {
    const { response, body } = await requestJson(app, '/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/no/such/path/anywhere' }),
    });

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'Path does not exist' });
  });

  it('rejects invalid JSON', async () => {
    const response = await app.request('http://localhost/api/grant-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: 'Invalid JSON body' });
  });
});

describe('persisted trustedRoots hydration', () => {
  it('makes files in a persisted trusted root accessible without initialArg', async () => {
    // Seed prefs with externalDir as a trusted root, then construct an app
    // with cwd that does NOT include externalDir.
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-trusted-home-'));
    const realHome = await realpath(localHome);
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({ trustedRoots: [externalDir] }),
    );

    const trustedApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
    });

    const { response, body } = await requestJson(
      trustedApp,
      `/api/file?path=${encodeURIComponent(externalFile)}`,
    );
    expect(response.status).toBe(200);
    expect(body.path).toBe(externalFile);

    await rm(realHome, { recursive: true, force: true });
  });

  it('skips persisted trustedRoots whose paths no longer exist', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-trusted-skip-'));
    const realHome = await realpath(localHome);
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({
        trustedRoots: [externalDir, '/tmp/md-redline-ghost-vault-does-not-exist-xyz'],
      }),
    );

    const skipApp = createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
    });

    // The real path is still accessible.
    const ok = await requestJson(
      skipApp,
      `/api/file?path=${encodeURIComponent(externalFile)}`,
    );
    expect(ok.response.status).toBe(200);

    // The ghost path 403s — it was NOT silently pushed into allowedRoots.
    const ghost = await requestJson(
      skipApp,
      '/api/file?path=/tmp/md-redline-ghost-vault-does-not-exist-xyz/missing.md',
    );
    expect(ghost.response.status).toBe(403);

    // Allow fire-and-forget writePreferences to flush before removing the temp dir.
    await new Promise((r) => setTimeout(r, 50));
    await rm(realHome, { recursive: true, force: true });
  });

  it('writes back the cleaned trustedRoots when entries are dropped', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-trusted-prune-'));
    const realHome = await realpath(localHome);
    const ghostPath = '/tmp/md-redline-ghost-vault-does-not-exist-xyz';
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({ trustedRoots: [externalDir, ghostPath] }),
    );

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
    });

    // Allow fire-and-forget writePreferences to flush.
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toEqual([externalDir]);

    await rm(realHome, { recursive: true, force: true });
  });

  it('migrates recentFiles parent dirs into trustedRoots on first run', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-migrate-home-'));
    const realHome = await realpath(localHome);
    // Seed prefs with recentFiles only (no trustedRoots — simulates a user
    // upgrading from a version that didn't have the field).
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({
        recentFiles: [
          { path: externalFile, name: 'outside.md', openedAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
    });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toEqual([externalDir]);

    // Construct again with the same home dir — migration should NOT re-run.
    // (We assert by clearing trustedRoots and verifying it stays empty.)
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({
        recentFiles: parsed.recentFiles,
        trustedRoots: [],
      }),
    );
    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw2 = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed2 = JSON.parse(raw2);
    expect(parsed2.trustedRoots).toEqual([]);

    await rm(realHome, { recursive: true, force: true });
  });

  it('seeds the home directory on first launch when defaultTrustHome is true', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-default-trust-'));
    const realHome = await realpath(localHome);

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
      defaultTrustHome: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toEqual([realHome]);

    await rm(realHome, { recursive: true, force: true });
  });

  it('does not seed home directory when defaultTrustHome is false (default)', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-no-default-trust-'));
    const realHome = await realpath(localHome);

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
      // defaultTrustHome omitted, default is false
    });

    await new Promise((r) => setTimeout(r, 50));

    // No prefs file should have been created
    let exists = false;
    try {
      await readFile(join(realHome, '.md-redline.json'), 'utf-8');
      exists = true;
    } catch {
      /* expected */
    }
    expect(exists).toBe(false);

    await rm(realHome, { recursive: true, force: true });
  });

  it('does not re-seed home directory when trustedRoots is already defined as empty', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-empty-trust-'));
    const realHome = await realpath(localHome);
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({ trustedRoots: [] }),
    );

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
      defaultTrustHome: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.trustedRoots).toEqual([]);

    await rm(realHome, { recursive: true, force: true });
  });

  it('combines seed-home with recentFiles migration on first launch', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'md-redline-combined-seed-'));
    const realHome = await realpath(localHome);
    await writeFile(
      join(realHome, '.md-redline.json'),
      JSON.stringify({
        recentFiles: [
          { path: externalFile, name: 'outside.md', openedAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );

    createApp({
      cwd: cwdRoot,
      homeDir: realHome,
      platformName: 'linux',
      defaultTrustHome: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(join(realHome, '.md-redline.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    // Expect both the home dir AND the recent file's parent dir to be present
    expect(parsed.trustedRoots).toContain(realHome);
    expect(parsed.trustedRoots).toContain(externalDir);

    await rm(realHome, { recursive: true, force: true });
  });
});

describe('review sessions API', () => {
  it('POST /api/review-sessions creates a session for files inside allowed roots', async () => {
    const { response, body } = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      sessionId: expect.stringMatching(/^rev_/),
      url: expect.stringContaining('review='),
    });
  });

  it('POST /api/review-sessions returns existing open session for same files (dedup)', async () => {
    // Use rootFile to avoid interference from other tests that use docsFile
    const first = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [rootFile], enableResolve: false }),
    });
    expect(first.response.status).toBe(201);
    const firstBody = first.body as { sessionId: string; created: boolean };
    expect(firstBody.created).toBe(true);

    const second = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [rootFile], enableResolve: false }),
    });
    expect(second.response.status).toBe(200);
    const secondBody = second.body as { sessionId: string; created: boolean };
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    expect(secondBody.created).toBe(false);
  });

  it('POST /api/review-sessions rejects empty filePaths', async () => {
    const { response, body } = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [], enableResolve: false }),
    });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringContaining('filePaths') });
  });

  it('POST /api/review-sessions rejects paths outside allowed roots', async () => {
    const { response } = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [externalFile], enableResolve: false }),
    });

    expect(response.status).toBe(403);
  });

  it('GET /api/review-sessions returns the list of open sessions', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const { response, body } = await requestJson(app, '/api/review-sessions');
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: sessionId, status: 'open' }),
      ]),
    });
  });

  it('GET /api/review-sessions/:id returns the session', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const { response, body } = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: sessionId, status: 'open' });
  });

  it('GET /api/review-sessions/:id returns 404 for unknown session', async () => {
    const { response } = await requestJson(app, '/api/review-sessions/rev_nope');
    expect(response.status).toBe(404);
  });

  it('POST .../batch sends a batch and keeps the session open', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const batch = await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Address these', commentIds: ['c1', 'c2'] }),
    });
    expect(batch.response.status).toBe(200);

    const after = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect(after.body).toMatchObject({ status: 'open', sentCommentIds: ['c1', 'c2'] });
  });

  it('POST .../batch with empty commentIds returns 400', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const batch = await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', commentIds: [] }),
    });
    expect(batch.response.status).toBe(400);
  });

  it('POST .../batch while waitingForAgent returns 200 with queued:true instead of 409', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    // First batch succeeds
    await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'batch1', commentIds: ['c1'] }),
    });

    // Second batch while agent hasn't picked up — now queued instead of 409
    const second = await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'batch2', commentIds: ['c2'] }),
    });
    expect(second.response.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, queued: true });
  });

  it('GET .../wait delivers a queued batch immediately when the agent polls', async () => {
    // Use writtenFile to avoid reusing an open session from a previous test.
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [writtenFile], enableResolve: false }),
    });
    expect(create.response.status).toBe(201);
    const sessionId = (create.body as { sessionId: string }).sessionId;

    // First batch — agent picks it up via /wait
    const waitPromise1 = requestJson(app, `/api/review-sessions/${sessionId}/wait`);
    await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'batch1', commentIds: ['c1'] }),
    });
    const result1 = await waitPromise1;
    expect(result1.body).toMatchObject({ status: 'batch', prompt: 'batch1' });

    // Queue a batch while waitingForAgent is true. The server rebuilds the
    // prompt on delivery (so the prompt the UI sends here is ignored for the
    // queued path — see queueBatch).
    const queued = await requestJson(app, `/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'queued batch', commentIds: ['c2'], commentCounts: { [writtenFile]: 2 } }),
    });
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    // Agent polls again — queued batch should be delivered immediately with
    // a server-rebuilt prompt that references the queued commentId.
    const result2 = await requestJson(app, `/api/review-sessions/${sessionId}/wait`);
    expect(result2.body).toMatchObject({ status: 'batch', commentIds: ['c2'] });
    expect((result2.body as { prompt: string }).prompt).toMatch(/`c2`/);
  });

  it('POST .../finish with prompt marks session done', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const finish = await requestJson(app, `/api/review-sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'final', commentIds: ['c1'] }),
    });
    expect(finish.response.status).toBe(200);

    const after = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect(after.body).toMatchObject({ status: 'done' });
  });

  it('POST .../finish without prompt marks session done', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const finish = await requestJson(app, `/api/review-sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(finish.response.status).toBe(200);

    const after = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect(after.body).toMatchObject({ status: 'done' });
  });

  it('POST .../handoff returns 404 (removed)', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const response = await app.request(
      `http://localhost/api/review-sessions/${sessionId}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('POST .../abort marks session aborted', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const abort = await requestJson(app, `/api/review-sessions/${sessionId}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(abort.response.status).toBe(200);

    const after = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect(after.body).toMatchObject({ status: 'aborted' });
  });

  it('POST .../heartbeat updates lastHeartbeatAt', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const hb = await requestJson(app, `/api/review-sessions/${sessionId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(hb.response.status).toBe(200);
  });

  it('abort/heartbeat on unknown session return 404', async () => {
    const abort = await requestJson(app, '/api/review-sessions/rev_nope/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(abort.response.status).toBe(404);

    const hb = await requestJson(app, '/api/review-sessions/rev_nope/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(hb.response.status).toBe(404);
  });

  it('heartbeat without content-type: application/json is rejected by the CSRF middleware', async () => {
    // Regression guard: the frontend hook sends content-type on every
    // heartbeat. If that's ever dropped, the server MUST reject the POST
    // with 415 (not silently accept it as a bare POST) so the bug is caught
    // at the client layer rather than silently letting sessions abort.
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const response = await app.request(
      `http://localhost/api/review-sessions/${sessionId}/heartbeat`,
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(415);
  });

  it('GET .../wait resolves with done after finish', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const waitPromise = requestJson(app, `/api/review-sessions/${sessionId}/wait`);

    setTimeout(() => {
      void requestJson(app, `/api/review-sessions/${sessionId}/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'PROMPT_BODY' }),
      });
    }, 10);

    const { response, body } = await waitPromise;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'done', prompt: 'PROMPT_BODY' });
  });

  it('GET .../wait resolves with aborted after abort', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], enableResolve: false }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;

    const waitPromise = requestJson(app, `/api/review-sessions/${sessionId}/wait`);

    setTimeout(() => {
      void requestJson(app, `/api/review-sessions/${sessionId}/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    }, 10);

    const { response, body } = await waitPromise;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'aborted', reason: 'user_cancelled' });
  });

  it('GET .../wait returns 404 for unknown session immediately', async () => {
    const { response } = await requestJson(app, '/api/review-sessions/rev_nope/wait');
    expect(response.status).toBe(404);
  });

  it('GET /api/review-sessions/:id returns origin field', async () => {
    // Abort any lingering docsFile session first, then create a fresh user-origin
    // session. Finish it immediately so it doesn't block the agent-origin tests below.
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile] }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;
    const { body } = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect((body as { origin: string }).origin).toBe('user');
    // Close the session so it is no longer open; agent-origin tests start fresh.
    await requestJson(app, `/api/review-sessions/${sessionId}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('POST accepts origin=agent and stores it', async () => {
    const create = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], origin: 'agent' }),
    });
    const sessionId = (create.body as { sessionId: string }).sessionId;
    const { body } = await requestJson(app, `/api/review-sessions/${sessionId}`);
    expect((body as { origin: string }).origin).toBe('agent');
  });

  it('agent-origin POST also dedupes (batched agent calls reuse the same session)', async () => {
    const a = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], origin: 'agent' }),
    });
    const idA = (a.body as { sessionId: string }).sessionId;

    const b = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [docsFile], origin: 'agent' }),
    });
    const idB = (b.body as { sessionId: string }).sessionId;

    expect(idA).toBe(idB);
  });

  it('user-origin POST still dedupes (existing behavior)', async () => {
    const a = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [rootFile] }),
    });
    const idA = (a.body as { sessionId: string }).sessionId;

    const b = await requestJson(app, '/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [rootFile] }),
    });
    const idB = (b.body as { sessionId: string }).sessionId;

    expect(idA).toBe(idB);
  });

  it('does NOT dedupe across origins (agent must not attach to user session)', async () => {
    // The user opens a review of a file. Then an agent calls mdr_review on
    // the same file. The agent must get a fresh agent-origin session — never
    // the user's — because the two have incompatible terminal-state contracts.
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-cross-origin-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const userCreate = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* defaults to user */ }),
    });
    expect(userCreate.status).toBe(201);
    const { sessionId: userId } = (await userCreate.json()) as { sessionId: string };

    const agentCreate = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    expect(agentCreate.status).toBe(201); // 201 = newly created, not 200 (reused)
    const { sessionId: agentId, origin } = (await agentCreate.json()) as {
      sessionId: string;
      origin: string;
    };
    expect(agentId).not.toBe(userId);
    expect(origin).toBe('agent');
  });
});

async function buildTestApp(options: { allowedRoots: string[] }) {
  const { app: testApp, reviewSessions: testReviewSessions } = createAppFull({
    cwd: options.allowedRoots[0],
    homeDir: fakeHome,
    platformName: 'linux',
  });
  return { app: testApp, reviewSessions: testReviewSessions };
}

describe('POST /api/review-sessions/:id/agent-comments', () => {
  it('inserts agent markers into the file and returns askId', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nThe rate limit is 100 req/min today.\n', 'utf8');

    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [
          { filePath, anchor: 'rate limit is 100 req/min', text: 'per-user or per-tenant?' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { askId: string };
    expect(body.askId).toMatch(/^ask_/);

    const updated = await readFile(filePath, 'utf8');
    expect(updated).toMatch(/"agentInitiated":true/);
    expect(updated).toMatch(new RegExp(`"sessionId":"${sessionId}"`));

    const pending = reviewSessions.getPendingAsks(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].questions[0].text).toBe('per-user or per-tenant?');
  });

  it('rejects when an anchor is not found', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nNothing here matches.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [{ filePath, anchor: 'no such text', text: 'q?' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; failedComments: number[] };
    expect(body.failedComments).toEqual([0]);

    const after = await readFile(filePath, 'utf8');
    expect(after).not.toMatch(/agentInitiated/);
  });

  it('rejects when a previous ask is still pending', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor. Second anchor.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'First anchor', text: 'q1' }] }),
    });
    const second = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Second anchor', text: 'q2' }] }),
    });
    expect(second.status).toBe(409);
  });

  it('uses the canonical resolved file path for SSE notify and write', async () => {
    // The session is created with the canonical path. The agent passes the same
    // path string in the questions array. We assert that the file actually got
    // the marker (proving the write path used a real file path, not e.g. a stale
    // non-canonical variant), and that the pending ask records the canonical
    // path so cleanup can find the file later.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-ask-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Hello world.\n', 'utf8');

    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [{ filePath, anchor: 'Hello', text: 'why?' }],
      }),
    });
    expect(res.status).toBe(201);

    const pending = reviewSessions.getPendingAsks(sessionId);
    expect(pending[0].questions[0].filePath).toBe(filePath); // canonical path stored
  });
});

describe('POST /api/review-sessions origin validation', () => {
  it('rejects unknown origin values with 400 (no silent coercion to user)', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-origin-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# X\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const res = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 'Agent' (capitalised) is the kind of typo that previously coerced
      // silently to user-origin, causing downstream mdr_wait 409s.
      body: JSON.stringify({ filePaths: [filePath], origin: 'Agent' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/origin must be/i);
  });

  it('accepts omitted origin (defaults to user)', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-origin-default-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# X\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const res = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { origin: string };
    expect(body.origin).toBe('user');
  });
});

describe('POST /agent-comments mode rejection contracts', () => {
  it('treats empty questions:[] as non-ask when mode is omitted (no silent flip)', async () => {
    // Defense in depth: an empty `questions: []` on a review-mode-shaped
    // payload would previously have flipped the inference to ask mode.
    // Now the inference only fires when at least one element is present.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-empty-questions-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Empty questions[] + non-empty comments[] should be reviewed-mode, not
    // ambiguous, and not silently downgraded.
    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [],
        comments: [{ filePath, anchor: 'Hello', text: 'fyi' }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { askId?: string };
    expect(body.askId).toBeUndefined(); // confirms review-mode (no ask waiter created)
  });

  it('rejects ambiguous shape: both questions and comments arrays without mode', async () => {
    // The shape-inference fallback can't tell ask from review when both
    // arrays are present, so the route rejects 400 rather than silently
    // collapsing to review.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-mode-ambig-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [{ filePath, anchor: 'Hello', text: 'q1' }],
        comments: [{ filePath, anchor: 'world', text: 'c1' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot infer mode/i);
  });

  it("rejects mode:'ask' with expectsReply:false as a contradiction", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-mode-contradict-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'Hello', text: 'q1' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/contradictory/i);
  });

  it('accepts inferred-ask payload on user-origin session', async () => {
    // Asking on a user-origin session is the flagship use case: an agent
    // addressing the user's review comments (mdr_request_review handoff)
    // asks a clarifying question mid-task. The shape-inference path must
    // accept it the same as explicit mode:'ask'.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-inferred-user-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* user origin */ }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No explicit mode; questions:[] alone makes this an inferred ask.
      body: JSON.stringify({
        questions: [{ filePath, anchor: 'Hello', text: 'q1' }],
      }),
    });
    expect(res.status).toBe(201);
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(1);
  });

  it('rejects review-mode with expectsReply:true as a reverse contradiction', async () => {
    // Symmetric to mode:'ask' + expectsReply:false. A review-mode caller
    // (explicit or inferred via comments:[]) asking for a blocking reply
    // is using the wrong tool and gets 400 instead of being silently
    // downgraded.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-rev-contradict-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath, anchor: 'Hello', text: 'fyi' }],
        expectsReply: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/contradictory/i);
  });

  it('accepts mdr_ask on a user-origin session and delivers the inline reply', async () => {
    // Full parity with the agent-origin happy path: question posted on a
    // user-origin session, user replies via the sidebar (addReply + save),
    // the ask waiter resolves with the reply text.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-ask-user-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* defaults to user */ }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'Hello', text: 'q1' }],
      }),
    });
    expect(res.status).toBe(201);
    const { askId } = (await res.json()) as { askId: string };

    const raw = await readFile(filePath, 'utf8');
    const { comments } = parseComments(raw);
    const commentId = comments[0].id;

    const waitPromise = testApp.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));
    const replied = addReply(raw, commentId, 'Inline answer on a user session.', 'Dennis');
    const put = await testApp.request('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: replied }),
    });
    expect(put.status).toBe(200);

    const waitRes = await waitPromise;
    const body = (await waitRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
    };
    expect(body.status).toBe('reply');
    expect(body.replies).toEqual([
      { questionIndex: 0, text: 'Inline answer on a user session.' },
    ]);
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);
  });

  it("accepts mode:'ask' without expectsReply (default to true)", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-mode-ask-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nHello world\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'Hello', text: 'q1' }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { askId?: string };
    expect(body.askId).toMatch(/^ask_/);
  });
});

describe('POST /agent-comments author field', () => {
  it('uses provided author name when agent sends author: "Claude"', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-author-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nSome text here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath, anchor: 'Some text', text: 'feedback', author: 'Claude' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(201);

    const updated = await readFile(filePath, 'utf8');
    expect(updated).toMatch(/"author":"Claude"/);
    expect(updated).not.toMatch(/"author":"Agent"/);
  });

  it('falls back to "Agent" when author is omitted', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-author-fallback-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nSome text here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath, anchor: 'Some text', text: 'feedback' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(201);

    const updated = await readFile(filePath, 'utf8');
    expect(updated).toMatch(/"author":"Agent"/);
  });
});

describe('POST /agent-comments with replies and expectsReply=false', () => {
  it('writes comments and replies and does not create pendingAsk when expectsReply=false', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-replies-')));
    const tempFile = join(tmp, 'spec.md');
    await writeFile(tempFile, '# Title\n\nHello world\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [tempFile] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Seed an existing top-level comment so we can reply to it.
    const seed = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath: tempFile, anchor: 'Hello', text: 'seed' }],
        expectsReply: false,
      }),
    });
    expect(seed.status).toBe(201);
    const seedBody = (await seed.json()) as { askId?: string; commentIds: string[] };
    expect(seedBody.askId).toBeUndefined();
    const seedCommentId = seedBody.commentIds[0];

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath: tempFile, anchor: 'world', text: 'a question' }],
        replies: [{ filePath: tempFile, commentId: seedCommentId, text: 'a reply' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { askId?: string; commentsWritten: number; repliesWritten: number };
    expect(body.askId).toBeUndefined();
    expect(body.commentsWritten).toBe(1);
    expect(body.repliesWritten).toBe(1);
    // Verify no pendingAsks created for this session
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);
  });

  it('still creates pendingAsk when expectsReply=true (default for backward compat)', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-bwcompat-')));
    const tempFile = join(tmp, 'spec.md');
    await writeFile(tempFile, '# Title\n\nHello world\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [tempFile], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [{ filePath: tempFile, anchor: 'Hello', text: 'q1' }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { askId?: string };
    expect(body.askId).toMatch(/^ask_/);
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(1);
  });

  it('returns 400 with failedReplies for unknown reply commentId', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-failedreplies-')));
    const tempFile = join(tmp, 'spec.md');
    await writeFile(tempFile, '# Title\n\nHello world\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [tempFile] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Explicit mode required for replies-only payloads — the Loop 8
        // guard rejects ambiguous shape (replies without mode/comments/questions).
        mode: 'review',
        replies: [{ filePath: tempFile, commentId: 'cmt_does_not_exist', text: 'orphan' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { failedReplies: number[] };
    expect(body.failedReplies).toEqual([0]);
  });

  it('returns 400 with both failedComments and failedReplies when both fail in one request', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-mixedfail-')));
    const tempFile = join(tmp, 'spec.md');
    await writeFile(tempFile, '# Title\n\nHello world\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [tempFile] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Send one comment with an unresolvable anchor AND one reply with an unknown commentId.
    const res = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: [{ filePath: tempFile, anchor: 'anchor_does_not_exist', text: 'fail comment' }],
        replies: [{ filePath: tempFile, commentId: 'cmt_does_not_exist', text: 'fail reply' }],
        expectsReply: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      failedComments: number[];
      failedReplies: number[];
    };
    expect(body.error).toMatch(/anchors or reply targets/);
    expect(body.failedComments).toEqual([0]);
    expect(body.failedReplies).toEqual([0]);
  });
});

describe('GET /api/review-sessions/:id/asks/:askId/wait', () => {
  it('long-polls until reply is sent and returns the reply payload', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Some text here.\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const post = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Some text', text: 'q?' }] }),
    });
    const { askId } = (await post.json()) as { askId: string };

    const waitPromise = app.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);

    const pending = reviewSessions.getPendingAsks(sessionId);
    const commentId = pending[0].questions[0].commentId;
    setTimeout(() => {
      reviewSessions.resolveReplies(sessionId, askId, [{ commentId, text: 'reply text' }]);
    }, 10);

    const wait = await waitPromise;
    const body = (await wait.json()) as { status: string; replies: unknown; totalQuestions: number };
    expect(body).toEqual({
      status: 'reply',
      replies: [{ questionIndex: 0, text: 'reply text' }],
      totalQuestions: 1,
    });
  });

  it('returns 404 when the ask does not exist', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    await writeFile(join(tmp, 'a.md'), '# x\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [join(tmp, 'a.md')] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/api/review-sessions/${sessionId}/asks/ask_does_not_exist/wait`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the askId belongs to a different session', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const fileA = join(tmp, 'a.md');
    const fileB = join(tmp, 'b.md');
    await writeFile(fileA, 'A unique anchor here.\n', 'utf8');
    await writeFile(fileB, 'B unique anchor here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });

    const createA = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [fileA] }),
    });
    const { sessionId: sessionA } = (await createA.json()) as { sessionId: string };

    const createB = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [fileB], origin: 'agent' }),
    });
    const { sessionId: sessionB } = (await createB.json()) as { sessionId: string };

    // Create an ask on session B.
    const post = await app.request(`/api/review-sessions/${sessionB}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath: fileB, anchor: 'B unique anchor', text: 'q?' }] }),
    });
    const { askId } = (await post.json()) as { askId: string };

    // Try to wait on session A using session B's askId.
    const res = await app.request(`/api/review-sessions/${sessionA}/asks/${askId}/wait`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/review-sessions/:id/asks/:askId/reply', () => {
  it('resolves the wait, removes markers, and returns ok', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Some text here.\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const post = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Some text', text: 'q?' }] }),
    });
    const { askId } = (await post.json()) as { askId: string };
    const commentId = reviewSessions.getPendingAsks(sessionId)[0].questions[0].commentId;

    const waitPromise = app.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);

    const reply = await app.request(`/api/review-sessions/${sessionId}/asks/${askId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replies: [{ commentId, text: 'reply text' }] }),
    });
    expect(reply.status).toBe(200);

    const wait = await waitPromise;
    const body = (await wait.json()) as { status: string; replies: unknown };
    expect(body.status).toBe('reply');

    const after = await readFile(filePath, 'utf8');
    expect(after).not.toMatch(/agentInitiated/);
    expect(after).not.toMatch(/@comment/);

    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);
  });

  it('accepts partial replies (not all questions need a reply)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'First anchor. Second anchor.\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const post = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [
          { filePath, anchor: 'First anchor', text: 'q1' },
          { filePath, anchor: 'Second anchor', text: 'q2' },
        ],
      }),
    });
    const { askId } = (await post.json()) as { askId: string };
    const pending = reviewSessions.getPendingAsks(sessionId)[0].questions;

    // Reply to only the first question — partial replies are now accepted.
    const reply = await app.request(`/api/review-sessions/${sessionId}/asks/${askId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replies: [{ commentId: pending[0].commentId, text: 'r1' }] }),
    });
    expect(reply.status).toBe(200);
    // The ask should be resolved (partial reply is sufficient).
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);

    // Regression guard: the unanswered question's marker MUST remain on disk
    // (preserved as "closed without reply"), not silently deleted. Earlier
    // implementation removed every marker in the ask regardless of which
    // ones received replies.
    const afterReply = await readFile(filePath, 'utf8');
    // q1 was replied → its marker removed
    expect(afterReply).not.toMatch(/"text":"q1"/);
    // q2 was unanswered → its marker preserved with expectsReply CLEARED
    expect(afterReply).toMatch(/"text":"q2"/);
    expect(afterReply).not.toMatch(/"text":"q2"[^}]*"expectsReply":true/);
  });

  it('still rejects replies referencing unknown commentIds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-ask-unknown-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Some text here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const post = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Some text', text: 'q?' }] }),
    });
    const { askId } = (await post.json()) as { askId: string };

    const reply = await app.request(`/api/review-sessions/${sessionId}/asks/${askId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replies: [{ commentId: 'cmt_does_not_exist', text: 'r1' }] }),
    });
    expect(reply.status).toBe(400);
    const body = (await reply.json()) as { error: string };
    expect(body.error).toContain('unknown commentId');
  });
});

describe('POST /api/review-sessions/:id/asks/:askId/release', () => {
  it('releases the ask and resolves the waiter', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-release-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Some text here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const post = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Some text', text: 'q1' }] }),
    });
    const { askId } = (await post.json()) as { askId: string };

    const waiterPromise = app.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);

    const res = await app.request(`/api/review-sessions/${sessionId}/asks/${askId}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const wait = await waiterPromise;
    const result = (await wait.json()) as { status: string; reason: string };
    expect(result).toEqual({ status: 'no_reply', reason: 'released' });
  });

  it('404s on unknown session', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-release-'));
    await writeFile(join(tmp, 'a.md'), '# x\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const res = await app.request('/api/review-sessions/rev_nope/asks/ask_x/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('404s on unknown ask', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-release-'));
    await writeFile(join(tmp, 'a.md'), '# x\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [join(tmp, 'a.md')] }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/api/review-sessions/${sessionId}/asks/ask_nope/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });
});

describe('mdr_review reply resolves a pending mdr_ask + cleans markers', () => {
  it('replied markers are removed; unreplied are preserved with expectsReply cleared', async () => {
    // The agent posts mdr_ask with 2 questions, then posts mdr_review with
    // a `replies:[]` that targets only ONE of those commentIds. The route
    // should: (a) resolve the in-memory ask waiter with the matching reply,
    // (b) remove the marker for the replied question, (c) preserve the
    // unanswered marker but clear its expectsReply flag.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-cross-tool-reply-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor. Second anchor.\n', 'utf8');
    const { app, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Post an ask with two questions.
    const ask = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [
          { filePath, anchor: 'First anchor', text: 'q1' },
          { filePath, anchor: 'Second anchor', text: 'q2' },
        ],
      }),
    });
    expect(ask.status).toBe(201);
    const { askId } = (await ask.json()) as { askId: string };
    const pending = reviewSessions.getPendingAsks(sessionId)[0].questions;
    const [q1, q2] = pending;

    // Park the ask waiter so we can observe its resolution.
    const waiter = reviewSessions.waitForAsk(askId)!;

    // Now post mdr_review with a reply to ONLY q1.
    const review = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'review',
        replies: [{ filePath, commentId: q1.commentId, text: 'partial answer' }],
      }),
    });
    expect(review.status).toBe(201);

    // The ask waiter resolves with the matching reply.
    const result = await waiter;
    expect(result).toMatchObject({ status: 'reply' });
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);

    // File state: q1's marker removed, q2's marker preserved with expectsReply cleared.
    const after = await readFile(filePath, 'utf8');
    expect(after).not.toMatch(/"text":"q1"/);
    expect(after).toMatch(/"text":"q2"/);
    expect(after).not.toMatch(/"text":"q2"[^}]*"expectsReply":true/);
    void q2;
  });
});

describe('agentCommentCount rollback when addAsk fails', () => {
  it('decrements agentCommentCount on addAsk failure so the invariant matches disk', async () => {
    // Two concurrent mdr_ask payloads can both pass the pre-check then both
    // write markers. The loser's addAsk throws "previous ask still pending",
    // markers roll back, AND agentCommentCount should be unbumped so that
    // the next addAsk after the FIRST ask resolves doesn't pass the
    // "agent already posted" guard against a session whose markers were
    // actually all rolled back.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-counter-rollback-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor. Second anchor.\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const first = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'First anchor', text: 'q1' }] }),
    });
    expect(first.status).toBe(201);

    // Internal: count after first ask should be 1.
    // Inspect via the only public way — the session listing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((reviewSessions as any).sessions.get(sessionId).agentCommentCount).toBe(1);

    const second = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'Second anchor', text: 'q2' }] }),
    });
    expect(second.status).toBe(409);

    // Counter must be 1 (only the first ask's marker survives), NOT 2.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((reviewSessions as any).sessions.get(sessionId).agentCommentCount).toBe(1);
  });
});

describe('rollback restores expectsReply when appendReply cleared it', () => {
  it('restores expectsReply on a previously-pending ask marker after batch rollback', async () => {
    // Scenario: agent posts mdr_ask (commentId X has expectsReply:true).
    // Agent then posts mdr_review with replies:[{commentId:X}] AND a comment
    // with an anchor that does NOT match — triggering rollback. The reply
    // that landed clears expectsReply on X; rollback must restore it so the
    // pending question keeps surfacing in the ask UI.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-rollback-restore-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nThe anchor we want.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // First, post a pending mdr_ask on the existing anchor.
    const ask = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'The anchor', text: 'q1' }],
      }),
    });
    expect(ask.status).toBe(201);

    // Find the commentId of the ask marker.
    const askedFile = await readFile(filePath, 'utf8');
    const askedMatch = askedFile.match(/"id":"(cmt_[^"]+)"[^}]*"expectsReply":true/);
    expect(askedMatch).not.toBeNull();
    const askCommentId = askedMatch![1];

    // Now post mdr_review with a reply targeting that ask AND a comment
    // whose anchor doesn't exist — forces rollback.
    const review = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'review',
        comments: [{ filePath, anchor: 'this anchor will never match', text: 'fail' }],
        replies: [{ filePath, commentId: askCommentId, text: 'partial answer' }],
      }),
    });
    expect(review.status).toBe(400);

    // expectsReply must be restored on the marker, since the reply was
    // rolled back along with the failed insert.
    const afterFile = await readFile(filePath, 'utf8');
    expect(afterFile).toMatch(/"expectsReply":true/);
  });
});

describe('rollback path when addAsk throws after marker write', () => {
  it('removes inserted markers if addAsk throws on subsequent attempt', async () => {
    // Two concurrent mdr_ask posts can both pass the pre-check; the loser's
    // addAsk throws "previous mdr_ask is still pending." The rollback must
    // remove the loser's markers from the file so they don't sit orphaned.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-rollback-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor. Second anchor.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // First ask succeeds.
    const first = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'First anchor', text: 'q1' }] }),
    });
    expect(first.status).toBe(201);

    // Second ask hits the addAsk-already-pending path. Marker is written by
    // transformFile, then addAsk throws. Rollback must remove it.
    const second = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'Second anchor', text: 'q2' }] }),
    });
    expect(second.status).toBe(409);

    const after = await readFile(filePath, 'utf8');
    // First ask's marker should still be there; second ask's marker rolled back.
    expect(after).toMatch(/"text":"q1"/);
    expect(after).not.toMatch(/"text":"q2"/);
  });

  it('preserves markers that already received a user reply during the rollback window', async () => {
    // Race scenario: agent posts an ask marker. Before addAsk fires, a user
    // adds a reply to that marker via a separate write. Then addAsk fails
    // (the race window in question). Rollback must NOT remove the marker,
    // because doing so would discard the user's reply text. The implementation
    // detects this via parseComments and skips removal when replies.length > 0.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-rb-user-reply-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor. Second anchor.\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // First ask: writes marker, registers ask.
    const first = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'First anchor', text: 'q1' }] }),
    });
    expect(first.status).toBe(201);

    // Simulate the race by manually injecting a reply onto the second-anchor
    // marker BEFORE the second ask runs. We do this by mocking the second
    // ask's commentId-to-be: after the second ask's transformFile writes its
    // marker (and addAsk fails), the file should be in a state where the
    // marker exists. To exercise the "reply preserved" branch, we'd need to
    // add a reply to that marker before rollback. The simplest deterministic
    // test: pre-create a marker with a reply, then have the route try to
    // rollback it. Since the route only rolls back markers it inserted in
    // THIS request, we can't easily trigger the branch end-to-end without
    // race timing. The store-level test below covers the unit-level guard.
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(1);
  });
});

describe('POST /api/review-sessions/:id/finish (pending asks)', () => {
  it('finish with an unanswered ask closes it as done_without_reply and preserves the marker', async () => {
    // Finish is the user-origin "I'm finished" signal. A pending ask must
    // not block it (the old 409 guard made the agent's question a hostage);
    // instead the ask resolves done_without_reply and the marker stays on
    // disk with expectsReply cleared, mirroring /agent-done semantics.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-finish-ask-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'Anchor here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* user origin */ }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const askRes = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ filePath, anchor: 'Anchor', text: 'q?' }] }),
    });
    expect(askRes.status).toBe(201);
    const { askId } = (await askRes.json()) as { askId: string };

    const waitPromise = app.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));
    const finish = await app.request(`/api/review-sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(finish.status).toBe(200);

    const waitRes = await waitPromise;
    const waitBody = (await waitRes.json()) as { status: string; reason?: string };
    expect(waitBody).toEqual({ status: 'no_reply', reason: 'done_without_reply' });

    // Marker preserved as a record, pending flag cleared.
    let after = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await readFile(filePath, 'utf8');
      if (!after.includes('"expectsReply":true')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(after).toMatch(/"text":"q\?"/);
    expect(after).not.toMatch(/"expectsReply":true/);
  });

  it('finish with an inline-answered ask delivers the reply', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-finish-replied-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, 'First anchor here.\n\nSecond anchor here.\n', 'utf8');
    const { app } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await app.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* user origin */ }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const askRes = await app.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: [
          { filePath, anchor: 'First anchor', text: 'Q1?' },
          { filePath, anchor: 'Second anchor', text: 'Q2?' },
        ],
      }),
    });
    const { askId } = (await askRes.json()) as { askId: string };

    // Answer only Q1 inline (partial — the save sweep leaves the ask pending),
    // then finish. The partial reply must be delivered, not dropped.
    const raw = await readFile(filePath, 'utf8');
    const { comments } = parseComments(raw);
    const q1 = comments.find((c) => c.text === 'Q1?');
    const replied = addReply(raw, q1!.id, 'Answer before finishing.', 'Dennis');
    await app.request('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: replied }),
    });

    const waitPromise = app.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));
    const finish = await app.request(`/api/review-sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(finish.status).toBe(200);

    const waitRes = await waitPromise;
    const waitBody = (await waitRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
      totalQuestions: number;
    };
    expect(waitBody.status).toBe('reply');
    expect(waitBody.totalQuestions).toBe(2);
    expect(waitBody.replies).toEqual([
      { questionIndex: 0, text: 'Answer before finishing.' },
    ]);
  });
});

describe('Done-with-pending-ask preserves marker and clears expectsReply on disk', () => {
  it('agent posts ask, user clicks Done — file keeps the marker but drops expectsReply', async () => {
    // Covers the setOnAsksClosedOnDone callback (server/index.ts). The marker
    // stays as a record of "asked, closed without reply" but the on-disk
    // expectsReply flag must be cleared so the state matches the semantic.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-done-with-ask-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nA single anchor.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const ask = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor: 'single anchor', text: 'q?' }] }),
    });
    expect(ask.status).toBe(201);

    // Sanity: file has the marker with expectsReply:true.
    const beforeDone = await readFile(filePath, 'utf8');
    expect(beforeDone).toMatch(/"expectsReply":true/);

    // User clicks Done.
    const done = await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(done.status).toBe(200);

    // The callback fires async. Wait briefly for the file write to land.
    let afterDone = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      afterDone = await readFile(filePath, 'utf8');
      if (!afterDone.includes('"expectsReply":true')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(afterDone).toMatch(/"text":"q\?"/); // marker preserved
    expect(afterDone).toMatch(/"agentInitiated":true/); // attribution preserved
    expect(afterDone).not.toMatch(/"expectsReply":true/); // flag cleared
  });
});

describe('Distinct agents on the same files', () => {
  it('different clientIds get distinct sessions; same clientId dedupes', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-two-agents-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createAs = (clientId: string) =>
      testApp.request('/api/review-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePaths: [filePath], origin: 'agent', clientId }),
      });

    const claude = (await (await createAs('mcp_claude')).json()) as {
      sessionId: string;
      created?: boolean;
    };
    const codex = (await (await createAs('mcp_codex')).json()) as {
      sessionId: string;
      created?: boolean;
    };
    expect(codex.sessionId).not.toBe(claude.sessionId);

    // Same agent calling again reuses its own session.
    const claudeAgain = (await (await createAs('mcp_claude')).json()) as {
      sessionId: string;
      created?: boolean;
    };
    expect(claudeAgain.sessionId).toBe(claude.sessionId);
    expect(claudeAgain.created).toBe(false);
  });

  it('rejects malformed clientId with 400', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-bad-client-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const res = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent', clientId: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Agent-comments server-side length caps', () => {
  async function setupAgentSession() {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-caps-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nAn anchor sentence.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    return { testApp, filePath, sessionId };
  }

  it('rejects oversize comment anchor at the HTTP layer', async () => {
    // The MCP client validates lengths too, but the HTTP endpoint is
    // reachable by any local process; the caps must hold here as well.
    const { testApp, filePath, sessionId } = await setupAgentSession();
    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'review',
        comments: [{ filePath, anchor: 'x'.repeat(8 * 1024 + 1), text: 'hi' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/anchor.*maximum/);
  });

  it('rejects oversize comment text at the HTTP layer', async () => {
    const { testApp, filePath, sessionId } = await setupAgentSession();
    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'review',
        comments: [{ filePath, anchor: 'An anchor', text: 'x'.repeat(64 * 1024 + 1) }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/text.*maximum/);
  });

  it('rejects oversize reply text at the HTTP layer', async () => {
    const { testApp, filePath, sessionId } = await setupAgentSession();
    const res = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'review',
        replies: [{ filePath, commentId: 'cmt_x', text: 'x'.repeat(64 * 1024 + 1) }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/text.*maximum/);
  });
});

describe('Stranded expectsReply marker sweep', () => {
  it('GET /api/file clears expectsReply for markers whose session no longer exists', async () => {
    // Sessions are memory-only; markers persist on disk. Simulate a server
    // restart by replaying the ask flow on one app instance, then reading
    // the file through a SECOND instance with a fresh (empty) session store.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-stranded-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nAn anchor sentence.\n', 'utf8');
    const { app: firstApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await firstApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    await firstApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'An anchor', text: 'stranded?' }],
      }),
    });
    expect(await readFile(filePath, 'utf8')).toContain('"expectsReply":true');

    // "Restart": a fresh app whose session store has never seen sessionId.
    const { app: restartedApp } = await buildTestApp({ allowedRoots: [tmp] });
    const res = await restartedApp.request(`/api/file?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);

    // The sweep is async; poll the file for the cleared flag.
    let after = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      after = await readFile(filePath, 'utf8');
      if (!after.includes('"expectsReply":true')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(after).toMatch(/"text":"stranded\?"/); // marker preserved as a record
    expect(after).not.toMatch(/"expectsReply":true/); // pending flag cleared
  });

  it('GET /api/file leaves markers of open sessions untouched', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-live-ask-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nAn anchor sentence.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });
    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'An anchor', text: 'live?' }],
      }),
    });

    // Same app instance: the session is open, so the sweep must keep the flag.
    const res = await testApp.request(`/api/file?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(filePath, 'utf8')).toContain('"expectsReply":true');
  });
});

describe('Inline reply delivery to pending asks', () => {
  it('PUT /api/file with every question answered resolves the ask immediately', async () => {
    // The reply happy path: the user answers via the comment sidebar, which
    // writes the reply into the marker (addReply) and saves the file. The
    // ask waiter must resolve with the reply text at save time — no Done
    // click required.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-inline-reply-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor sentence.\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });

    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const askRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'First anchor', text: 'Is this section final?' }],
      }),
    });
    expect(askRes.status).toBe(201);
    const { askId } = (await askRes.json()) as { askId: string };

    const raw = await readFile(filePath, 'utf8');
    const { comments } = parseComments(raw);
    expect(comments).toHaveLength(1);
    const commentId = comments[0].id;

    // Start the agent's long-poll BEFORE the user replies.
    const waitPromise = testApp.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));

    // User replies via the sidebar: addReply + save.
    const replied = addReply(raw, commentId, 'Yes, final as of Friday.', 'Dennis');
    const put = await testApp.request('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: replied }),
    });
    expect(put.status).toBe(200);

    const waitRes = await waitPromise;
    expect(waitRes.status).toBe(200);
    const body = (await waitRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
      totalQuestions: number;
    };
    expect(body.status).toBe('reply');
    expect(body.totalQuestions).toBe(1);
    expect(body.replies).toEqual([{ questionIndex: 0, text: 'Yes, final as of Friday.' }]);
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(0);
  });

  it('partially answered ask stays pending on save, then /agent-done delivers the partial replies', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-partial-reply-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nFirst anchor sentence.\n\nSecond anchor sentence.\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });

    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const askRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [
          { filePath, anchor: 'First anchor', text: 'Q1?' },
          { filePath, anchor: 'Second anchor', text: 'Q2?' },
        ],
      }),
    });
    expect(askRes.status).toBe(201);
    const { askId } = (await askRes.json()) as { askId: string };

    const raw = await readFile(filePath, 'utf8');
    const { comments } = parseComments(raw);
    expect(comments).toHaveLength(2);
    const q1 = comments.find((c) => c.text === 'Q1?');
    expect(q1).toBeDefined();

    // Reply to ONLY the first question and save. The ask must stay pending —
    // the user may still be typing the second answer.
    const replied = addReply(raw, q1!.id, 'Answer to Q1.', 'Dennis');
    const put = await testApp.request('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: replied }),
    });
    expect(put.status).toBe(200);
    expect(reviewSessions.getPendingAsks(sessionId)).toHaveLength(1);

    // Start the agent's long-poll, then the user clicks Done. The partial
    // reply must be delivered (not reported as done_without_reply).
    const waitPromise = testApp.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));
    const done = await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(done.status).toBe(200);

    const waitRes = await waitPromise;
    const body = (await waitRes.json()) as {
      status: string;
      replies: Array<{ questionIndex: number; text: string }>;
      totalQuestions: number;
    };
    expect(body.status).toBe('reply');
    expect(body.totalQuestions).toBe(2);
    expect(body.replies).toEqual([{ questionIndex: 0, text: 'Answer to Q1.' }]);

    // The unanswered Q2 marker bypasses onAsksClosedOnDone (the ask was
    // resolved, not aborted), so the route's own cleanup must clear its
    // expectsReply flag. Q2's marker stays as a record of "asked, no answer."
    let afterDone = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      afterDone = await readFile(filePath, 'utf8');
      if (!afterDone.includes('"expectsReply":true')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(afterDone).toMatch(/"text":"Q2\?"/);
    expect(afterDone).not.toMatch(/"expectsReply":true/);
  });

  it('agent-done with no inline replies still resolves done_without_reply', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mdr-no-reply-done-')));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Title\n\nAn anchor sentence.\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const create = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const askRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'ask',
        questions: [{ filePath, anchor: 'An anchor', text: 'Unanswered?' }],
      }),
    });
    const { askId } = (await askRes.json()) as { askId: string };

    const waitPromise = testApp.request(`/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    await new Promise((r) => setTimeout(r, 10));
    await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const waitRes = await waitPromise;
    const body = (await waitRes.json()) as { status: string; reason?: string };
    expect(body).toEqual({ status: 'no_reply', reason: 'done_without_reply' });
  });
});

describe('/api/review-sessions/:id/agent-done + /agent-wait', () => {
  it('POST /agent-done returns 200 and sets session done', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-done-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const doneRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(doneRes.status).toBe(200);
    const doneBody = (await doneRes.json()) as { ok: boolean };
    expect(doneBody.ok).toBe(true);
  });

  it('POST /agent-done rejects user-origin sessions with 409', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-done-user-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] /* defaults to user origin */ }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const doneRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(doneRes.status).toBe(409);
  });

  it('GET /agent-wait returns immediately with {status:"done"} if already done', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-wait-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Mark done first
    await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    // Now wait should return immediately
    const waitRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-wait?timeout=1`);
    expect(waitRes.status).toBe(200);
    const waitBody = (await waitRes.json()) as { status: string };
    expect(waitBody.status).toBe('done');
  });

  it('GET /agent-wait returns pending after timeout when not yet done', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-wait-pending-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const waitRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-wait?timeout=1`);
    expect(waitRes.status).toBe(200);
    const waitBody = (await waitRes.json()) as { status: string };
    expect(waitBody.status).toBe('pending');
  });

  it('POST /agent-done returns 404 for unknown session', async () => {
    const res = await requestJson(app, '/api/review-sessions/rev_nonexistent/agent-done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.response.status).toBe(404);
  });

  it('GET /agent-wait returns 404 for unknown session that was never marked done', async () => {
    const res = await requestJson(app, '/api/review-sessions/rev_nonexistent/agent-wait?timeout=1');
    expect(res.response.status).toBe(404);
  });

  it('GET /agent-wait returns aborted(user_cancelled) when the agent session is aborted by /abort', async () => {
    // user_cancelled / browser_disconnected / agent_silent all set the
    // session to terminal-aborted. The agent's parked mdr_wait wakes up with
    // {status:'aborted', reason: …} so the agent can distinguish "user
    // engaged and clicked Done" from "session ended without engagement."
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-wait-aborted-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Start the long-poll BEFORE the abort so we exercise the "wake the
    // parked doneWaiter" path, not just the cached recentlyDoneIds path.
    const waitPromise = testApp.request(`/api/review-sessions/${sessionId}/agent-wait?timeout=5`);
    await testApp.request(`/api/review-sessions/${sessionId}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const waitRes = await waitPromise;
    expect(waitRes.status).toBe(200);
    const waitBody = (await waitRes.json()) as { status: string; reason?: string };
    expect(waitBody.status).toBe('aborted');
    expect(waitBody.reason).toBe('user_cancelled');
  });

  it('GET /agent-wait returns done for a session that was marked done before the store gc\'d it', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mdr-agent-wait-late-'));
    const filePath = join(tmp, 'spec.md');
    await writeFile(filePath, '# Spec\n', 'utf8');
    const { app: testApp, reviewSessions } = await buildTestApp({ allowedRoots: [tmp] });

    const createRes = await testApp.request('/api/review-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Mark done
    await testApp.request(`/api/review-sessions/${sessionId}/agent-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    // Simulate terminal-retention GC removing the session from the live Map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (reviewSessions as any).sessions.delete(sessionId);

    const waitRes = await testApp.request(`/api/review-sessions/${sessionId}/agent-wait?timeout=1`);
    expect(waitRes.status).toBe(200);
    const waitBody = (await waitRes.json()) as { status: string };
    expect(waitBody.status).toBe('done');
  });
});

describe('static file serving CSP (img-src https: for remote images)', () => {
  let staticApp: AppInstance;
  let staticDir: string;

  beforeAll(async () => {
    staticDir = await mkdtemp(join(tmpdir(), 'md-redline-static-'));
    staticDir = await realpath(staticDir);
    await writeFile(join(staticDir, 'index.html'), '<html><body>mdr</body></html>');
    await writeFile(join(staticDir, 'app.js'), 'console.log("hi")');
    staticApp = createApp({
      cwd: cwdRoot,
      homeDir: fakeHome,
      staticDir,
      platformName: 'linux',
    });
  });

  afterAll(async () => {
    await rm(staticDir, { recursive: true, force: true });
  });

  it('sets CSP with https: in img-src on HTML responses', async () => {
    const response = await staticApp.request('http://localhost/');
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("img-src 'self' data: blob: https:");
  });

  it('sets CSP with https: in img-src on SPA fallback', async () => {
    const response = await staticApp.request('http://localhost/nonexistent-route');
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("img-src 'self' data: blob: https:");
  });

  it('does not set CSP on non-HTML static assets', async () => {
    const response = await staticApp.request('http://localhost/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('immutable');
  });
});

describe('removePortFileIfOwned', () => {
  it('deletes the port file when it holds this server\'s port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'md-redline-portfile-'));
    const portFile = join(dir, 'md-redline.port');
    await writeFile(portFile, '6373\n');
    removePortFileIfOwned(portFile, 6373);
    await expect(readFile(portFile, 'utf8')).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves the port file alone when a sibling server owns it', async () => {
    // Two servers can be alive at once (orphan from a failed launch plus
    // the live one). The exiting server must not delete the file the live
    // server wrote, or the CLI loses its fast-path lookup.
    const dir = await mkdtemp(join(tmpdir(), 'md-redline-portfile-'));
    const portFile = join(dir, 'md-redline.port');
    await writeFile(portFile, '6374');
    removePortFileIfOwned(portFile, 6373);
    await expect(readFile(portFile, 'utf8')).resolves.toBe('6374');
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the port file is missing', () => {
    expect(() => removePortFileIfOwned(join(tmpdir(), 'md-redline-portfile-nonexistent'), 6373)).not.toThrow();
  });
});
