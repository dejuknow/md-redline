import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp, type CreateAppOptions } from './index';

type AppInstance = ReturnType<typeof createApp>;

let app: AppInstance;
let initialFileApp: AppInstance;
let initialDirApp: AppInstance;

let cwdRoot: string;
let fakeHome: string;
let initialDir: string;
let externalDir: string;
let docsDir: string;

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
  const nestedDir = join(docsDir, 'nested');
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

  await symlink(homeFile, allowedSymlinkFile);
  await symlink(externalFile, outsideSymlinkFile);
  await symlink(fakeHome, allowedSymlinkDir);
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
    expect(body).toEqual({ initialFile: '', initialDir: '' });
  });

  it('returns the configured initial file or directory', async () => {
    const fileConfig = await requestJson(initialFileApp, '/api/config');
    const dirConfig = await requestJson(initialDirApp, '/api/config');

    expect(fileConfig.body).toEqual({
      initialFile: join(initialDir, 'initial.md'),
      initialDir: '',
    });
    expect(dirConfig.body).toEqual({
      initialFile: '',
      initialDir,
    });
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

  it('expands tilde paths against the configured home directory', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent('~/home.md')}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: homeFile,
      content: '# Home\n',
    });
  });

  it('expands Windows-style tilde paths against the configured home directory', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/file?path=${encodeURIComponent('~\\home.md')}`,
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      path: homeFile,
      content: '# Home\n',
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
      path: homeFile,
      content: '# Home\n',
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
    expect(body).toEqual({ success: true, path: writtenFile });
    await expect(readFile(writtenFile, 'utf-8')).resolves.toBe(newContent);
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
    expect(body).toEqual({ success: true, path: initialSiblingFile });
    await expect(readFile(initialSiblingFile, 'utf-8')).resolves.toBe(newContent);
  });
});

describe('/api/files', () => {
  it('lists only lowercase .md files in the requested directory', async () => {
    const { response, body } = await requestJson(
      app,
      `/api/files?dir=${encodeURIComponent(docsDir)}`,
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({
      dir: docsDir,
      files: [
        join(docsDir, 'alpha.md'),
        writtenFile,
        join(docsDir, 'zeta.md'),
      ],
    });
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
      dir: fakeHome,
      files: [homeFile],
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
      dir: fakeHome,
      parent: null,
      directories: [],
      files: [{ name: 'home.md', path: homeFile }],
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
});

describe('/api/reveal', () => {
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
