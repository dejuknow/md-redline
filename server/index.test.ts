import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp, isPathInsideRoot, type CreateAppOptions } from './index';

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
