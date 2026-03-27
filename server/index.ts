import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { readFile, writeFile, readdir, stat, realpath } from 'fs/promises';
import { watch, statSync, realpathSync, type FSWatcher } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';

export interface CreateAppOptions {
  cwd?: string;
  execFileImpl?: typeof execFile;
  homeDir?: string;
  initialArg?: string;
  platformName?: NodeJS.Platform;
}

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isMdFile(resolved: string): boolean {
  return extname(resolved).toLowerCase() === '.md';
}

function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function sseFrame(event: string, data: string): Uint8Array {
  const lines = data.split('\n');
  const frame = `event: ${event}\n${lines.map((l) => `data: ${l}`).join('\n')}\n\n`;
  return sseEncoder.encode(frame);
}

const sseEncoder = new TextEncoder();

export function createApp(options: CreateAppOptions = {}) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const initialArgRaw = options.initialArg ?? process.argv[2] ?? '';
  const initialArg = initialArgRaw ? resolve(cwd, initialArgRaw) : '';
  const platformName = options.platformName ?? platform();
  const execFileImpl = options.execFileImpl ?? execFile;

  const app = new Hono();
  app.use('*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
  app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));

  let initialFile = '';
  let initialDir = '';
  try {
    const argStat = initialArg ? statSync(initialArg) : null;
    if (argStat?.isDirectory()) {
      initialDir = initialArg;
    } else if (initialArg) {
      initialFile = initialArg;
    }
  } catch {
    if (initialArg) initialFile = initialArg;
  }

  const allowedRoots = [canonicalize(cwd), canonicalize(homeDir)];
  if (initialFile) {
    const fileDir = canonicalize(dirname(initialFile));
    if (!allowedRoots.some((root) => fileDir.startsWith(root + '/') || fileDir === root)) {
      allowedRoots.push(fileDir);
    }
  }
  if (initialDir) {
    const dir = canonicalize(initialDir);
    if (!allowedRoots.some((root) => dir.startsWith(root + '/') || dir === root)) {
      allowedRoots.push(dir);
    }
  }

  async function resolveAndValidate(inputPath: string): Promise<string> {
    const expanded = expandHomePath(inputPath, homeDir);
    const resolved = resolve(cwd, expanded);
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

  const lastWrittenContent = new Map<string, string>();
  const fileWatchers = new Map<
    string,
    { watcher: FSWatcher; clients: Set<WritableStreamDefaultWriter> }
  >();

  app.get('/api/config', (c) => {
    return c.json({ initialFile, initialDir });
  });

  app.get('/api/file', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);

    try {
      const resolved = await resolveAndValidate(path);
      if (!isMdFile(resolved)) {
        return c.json({ error: 'Only .md files are supported' }, 400);
      }
      const content = await readFile(resolved, 'utf-8');
      return c.json({ content, path: resolved });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('GET /api/file failed:', err);
      return c.json({ error: 'File not found or not readable' }, 404);
    }
  });

  app.put('/api/file', async (c) => {
    let body: { path: string; content: string };
    try {
      body = await c.req.json<{ path: string; content: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.path || body.content === undefined) {
      return c.json({ error: 'path and content are required' }, 400);
    }

    try {
      const resolved = await resolveAndValidate(body.path);
      if (!isMdFile(resolved)) {
        return c.json({ error: 'Only .md files are supported' }, 400);
      }
      lastWrittenContent.set(resolved, body.content);
      await writeFile(resolved, body.content, 'utf-8');
      return c.json({ success: true, path: resolved });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('PUT /api/file failed:', err);
      return c.json({ error: 'Failed to write file' }, 500);
    }
  });

  app.get('/api/files', async (c) => {
    const dir = c.req.query('dir') || cwd;

    try {
      const resolved = await resolveAndValidate(dir);
      const entries = await readdir(resolved, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
        .map((entry) => join(resolved, entry.name));
      files.sort((a, b) => a.localeCompare(b));
      return c.json({ files, dir: resolved });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('GET /api/files failed:', err);
      return c.json({ error: 'Directory not found' }, 404);
    }
  });

  app.get('/api/browse', async (c) => {
    const dir = c.req.query('dir') || cwd;

    try {
      const resolved = await resolveAndValidate(dir);
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        return c.json({ error: 'Not a directory' }, 400);
      }

      const entries = await readdir(resolved, { withFileTypes: true });

      const directories = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const files = entries
        .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
        .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = dirname(resolved);
      let parentAllowed = false;
      try {
        await resolveAndValidate(parent);
        parentAllowed = true;
      } catch {
        /* parent outside allowed roots */
      }

      return c.json({
        dir: resolved,
        parent: parentAllowed && parent !== resolved ? parent : null,
        directories,
        files,
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('GET /api/browse failed:', err);
      return c.json({ error: 'Directory not found or not accessible' }, 404);
    }
  });

  app.get('/api/pick-file', async (c) => {
    try {
      const path = await new Promise<string>((promiseResolve, reject) => {
        if (platformName === 'darwin') {
          execFileImpl(
            'osascript',
            [
              '-e',
              'set f to POSIX path of (choose file of type {"md", "markdown", "public.plain-text"} with prompt "Choose a markdown file")',
              '-e',
              'return f',
            ],
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'linux') {
          execFileImpl(
            'zenity',
            [
              '--file-selection',
              '--title=Choose a markdown file',
              '--file-filter=Markdown files | *.md *.markdown',
            ],
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'win32') {
          execFileImpl(
            'powershell',
            [
              '-NoProfile',
              '-STA',
              '-Command',
              'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Filter = "Markdown files (*.md;*.markdown)|*.md;*.markdown|All files (*.*)|*.*"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
            ],
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else {
          reject(new Error('Unsupported platform'));
        }
      });
      if (!path) return c.json({ error: 'No file selected' }, 400);
      return c.json({ path });
    } catch {
      return c.json({ cancelled: true });
    }
  });

  app.get('/api/watch', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);

    let resolved: string;
    try {
      resolved = await resolveAndValidate(path);
      if (!isMdFile(resolved)) return c.json({ error: 'Only .md files are supported' }, 400);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      return c.json({ error: 'File not found' }, 404);
    }

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    if (!fileWatchers.has(resolved)) {
      const clients = new Set<WritableStreamDefaultWriter>();
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const cleanUpWatcher = () => {
        for (const client of clients) {
          client.close().catch(() => {});
        }
        clients.clear();
        watcher.close();
        fileWatchers.delete(resolved);
      };
      const watcher = watch(resolved, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
          try {
            const content = await readFile(resolved, 'utf-8');
            if (lastWrittenContent.get(resolved) === content) return;
            lastWrittenContent.delete(resolved);
            const frame = sseFrame('change', JSON.stringify({ content, path: resolved }));
            for (const client of clients) {
              client.write(frame).catch(() => {});
            }
          } catch {
            const frame = sseFrame(
              'error',
              JSON.stringify({ path: resolved, reason: 'file_gone' }),
            );
            for (const client of clients) {
              client.write(frame).catch(() => {});
            }
            cleanUpWatcher();
          }
        }, 150);
      });
      watcher.on('error', cleanUpWatcher);
      fileWatchers.set(resolved, { watcher, clients });
    }

    const entry = fileWatchers.get(resolved)!;
    entry.clients.add(writer);

    writer.write(sseFrame('connected', JSON.stringify({ path: resolved }))).catch(() => {});

    c.req.raw.signal.addEventListener('abort', () => {
      entry.clients.delete(writer);
      writer.close().catch(() => {});
      if (entry.clients.size === 0) {
        entry.watcher.close();
        fileWatchers.delete(resolved);
      }
    });

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/api/platform', (c) => {
    return c.json({ platform: platformName });
  });

  app.post('/api/reveal', async (c) => {
    let body: { path: string };
    try {
      body = await c.req.json<{ path: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.path) return c.json({ error: 'path is required' }, 400);

    try {
      const resolved = await resolveAndValidate(body.path);
      await new Promise<void>((promiseResolve, reject) => {
        if (platformName === 'darwin') {
          execFileImpl('open', ['-R', resolved], (err) => {
            if (err) return reject(err);
            promiseResolve();
          });
        } else if (platformName === 'linux') {
          execFileImpl('xdg-open', [dirname(resolved)], (err) => {
            if (err) return reject(err);
            promiseResolve();
          });
        } else if (platformName === 'win32') {
          execFileImpl('explorer', ['/select,', resolved], (err) => {
            if (err) return reject(err);
            promiseResolve();
          });
        } else {
          reject(new Error('Unsupported platform'));
        }
      });
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('POST /api/reveal failed:', err);
      return c.json({ error: 'Failed to reveal file' }, 500);
    }
  });

  return app;
}

export const app = createApp();

const port = 3001;
const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`md-review server running on http://localhost:${port}`);
    const initialArg = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : '';
    if (initialArg) {
      console.log(`Initial path: ${initialArg}`);
    }
  });
}
