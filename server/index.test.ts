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
});

describe('/api/reveal', () => {
  it('uses osascript on macOS to reveal and activate Finder', async () => {
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
    expect(calls[0].args).toContain('-e');
    expect(calls[0].args.join(' ')).toContain('tell application "Finder" to reveal');
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
