import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { readFile, readdir, stat, realpath, rename, open } from 'fs/promises';
import { watch, statSync, realpathSync, unlinkSync, type FSWatcher } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { homedir, platform, tmpdir } from 'os';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { readPreferences, writePreferences } from './preferences';

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

function normalizePathForComparison(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const comparable = normalized || '/';
  return caseInsensitive ? comparable.toLowerCase() : comparable;
}

export function isPathInsideRoot(path: string, root: string, caseInsensitive = false): boolean {
  const normalizedPath = normalizePathForComparison(path, caseInsensitive);
  const normalizedRoot = normalizePathForComparison(root, caseInsensitive);
  if (normalizedRoot === '/') return true;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
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
  const homeDir = options.homeDir ?? process.env.MD_REDLINE_HOME ?? homedir();
  const initialArgRaw = options.initialArg ?? process.argv[2] ?? '';
  const initialArg = initialArgRaw ? resolve(cwd, initialArgRaw) : '';
  const platformName = options.platformName ?? platform();
  const execFileImpl = options.execFileImpl ?? execFile;
  const caseInsensitivePaths = platformName === 'win32';

  const app = new Hono();
  // Allow CORS only from Vite dev server ports (default 5188-5197, or custom via env)
  const viteBasePort = Number.parseInt(process.env.MD_REDLINE_VITE_PORT ?? '5188', 10);
  const allowedPorts = new Set<number>();
  for (let p = viteBasePort; p < viteBasePort + 10; p++) allowedPorts.add(p);
  // Also allow the default range if a custom port is configured
  if (viteBasePort !== 5188) {
    for (let p = 5188; p < 5198; p++) allowedPorts.add(p);
  }
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return `http://localhost:${viteBasePort}`;
        try {
          const url = new URL(origin);
          if (
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
            url.port !== '' &&
            allowedPorts.has(Number(url.port))
          ) {
            return origin;
          }
        } catch {
          /* invalid origin */
        }
        return null;
      },
    }),
  );
  app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));
  // Enforce application/json Content-Type on POST/PUT to block CSRF via text/plain forms
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'PUT') {
      const ct = c.req.header('content-type') ?? '';
      if (!ct.includes('application/json')) {
        return c.json({ error: 'Content-Type must be application/json' }, 415);
      }
    }
    await next();
  });

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

  const allowedRoots = [canonicalize(cwd)];
  // When opening a single file, grant access to its parent directory so
  // the user can navigate to sibling files via the explorer.
  if (initialFile) {
    const fileDir = canonicalize(dirname(initialFile));
    if (!allowedRoots.some((root) => isPathInsideRoot(fileDir, root, caseInsensitivePaths))) {
      allowedRoots.push(fileDir);
    }
  }
  if (initialDir) {
    const dir = canonicalize(initialDir);
    if (!allowedRoots.some((root) => isPathInsideRoot(dir, root, caseInsensitivePaths))) {
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
      // File may not exist yet — resolve via its parent
      const parent = dirname(resolved);
      try {
        const realParent = await realpath(parent);
        real = join(realParent, resolved.slice(parent.length + 1));
      } catch {
        // Parent doesn't exist either — cannot safely validate the path
        throw new Error('Access denied: cannot resolve path');
      }
    }
    const allowed = allowedRoots.some((root) => isPathInsideRoot(real, root, caseInsensitivePaths));
    if (!allowed) {
      throw new Error('Access denied: path outside allowed directories');
    }
    return real;
  }

  const lastWrittenContent = new Map<string, string>();
  const writeLocks = new Map<string, Promise<void>>();
  const fileWatchers = new Map<
    string,
    {
      watcher: FSWatcher;
      clients: Set<WritableStreamDefaultWriter>;
      cleanup: () => void;
    }
  >();

  app.get('/api/config', (c) => {
    return c.json({ initialFile, initialDir });
  });

  app.get('/api/preferences', async (c) => {
    return c.json(await readPreferences(homeDir));
  });

  app.put('/api/preferences', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    try {
      const merged = await writePreferences(homeDir, body);
      return c.json(merged);
    } catch (err) {
      console.error('PUT /api/preferences failed:', err);
      return c.json({ error: 'Failed to save preferences' }, 500);
    }
  });

  app.get('/api/file', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);

    try {
      const resolved = await resolveAndValidate(path);
      if (!isMdFile(resolved)) {
        return c.json({ error: 'Only .md files are supported' }, 400);
      }
      const [content, fileStat] = await Promise.all([
        readFile(resolved, 'utf-8'),
        stat(resolved),
      ]);
      return c.json({ content, path: resolved, mtime: fileStat.mtimeMs });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('GET /api/file failed:', err);
      return c.json({ error: 'File not found or not readable' }, 404);
    }
  });

  app.put('/api/file', async (c) => {
    let body: { path: string; content: string; expectedMtime?: number };
    try {
      body = await c.req.json<{ path: string; content: string; expectedMtime?: number }>();
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
      // Serialize writes to the same path to prevent concurrent write races
      const commentCount = (body.content.match(/@comment\{/g) ?? []).length;
      const prevLock = writeLocks.get(resolved) ?? Promise.resolve();
      let conflictResponse: Response | null = null;
      const currentWrite = prevLock
        .then(async () => {
          // Conflict detection: if the client sent an expectedMtime, verify the
          // file hasn't been modified externally since the client last loaded it.
          if (body.expectedMtime != null) {
            try {
              const currentStat = await stat(resolved);
              if (Math.abs(currentStat.mtimeMs - body.expectedMtime) > 1) {
                const currentContent = await readFile(resolved, 'utf-8');
                conflictResponse = c.json(
                  {
                    error: 'File was modified externally. Reload to see the latest version.',
                    code: 'CONFLICT',
                    currentContent,
                    mtime: currentStat.mtimeMs,
                  },
                  409,
                );
                return;
              }
            } catch {
              // File may have been deleted — proceed with write to recreate it
            }
          }

          // Atomic write: write to a temp file then rename, so a crash
          // mid-write can't leave a half-written file on disk.
          // Use O_EXCL to prevent symlink clobber attacks on the temp file.
          const tmpPath = `${resolved}.tmp`;
          try {
            unlinkSync(tmpPath);
          } catch {
            // No existing file — fine
          }
          const fd = await open(tmpPath, 'wx');
          try {
            await fd.writeFile(body.content, 'utf-8');
          } finally {
            await fd.close();
          }
          await rename(tmpPath, resolved);
          lastWrittenContent.set(resolved, body.content);
          console.log(
            `[SAVE OK] ${resolved} — ${commentCount} comment(s), ${body.content.length} bytes`,
          );
        })
        .finally(() => {
          if (writeLocks.get(resolved) === currentWrite) {
            writeLocks.delete(resolved);
          }
        });
      writeLocks.set(resolved, currentWrite);
      await currentWrite;
      if (conflictResponse) return conflictResponse;
      const newStat = await stat(resolved);
      return c.json({ success: true, path: resolved, mtime: newStat.mtimeMs });
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
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
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
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
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
      // Validate the picked path (OS picker returns an absolute path)
      if (!isMdFile(path)) {
        return c.json({ error: 'Only .md files are supported' }, 400);
      }
      // Grant access to the file's directory so subsequent API calls work
      const pickedDir = dirname(resolve(path));
      try {
        const realDir = canonicalize(pickedDir);
        if (!allowedRoots.some((root) => isPathInsideRoot(realDir, root, caseInsensitivePaths))) {
          allowedRoots.push(realDir);
        }
      } catch {
        // Can't canonicalize — add the raw resolved dir
        if (!allowedRoots.some((root) => isPathInsideRoot(pickedDir, root, caseInsensitivePaths))) {
          allowedRoots.push(pickedDir);
        }
      }
      return c.json({ path });
    } catch {
      return c.json({ cancelled: true });
    }
  });

  app.get('/api/watch', async (c) => {
    // Accept one or many paths: ?path=a&path=b (single SSE for all)
    const paths = c.req.queries('path') ?? [];
    if (paths.length === 0) return c.json({ error: 'path query parameter is required' }, 400);

    const resolvedPaths: string[] = [];
    for (const p of paths) {
      try {
        const resolved = await resolveAndValidate(p);
        if (!isMdFile(resolved)) {
          if (paths.length === 1) return c.json({ error: 'Only .md files are supported' }, 400);
          continue;
        }
        resolvedPaths.push(resolved);
      } catch (err) {
        if (paths.length === 1) {
          if (err instanceof Error && err.message.startsWith('Access denied')) {
            return c.json({ error: err.message }, 403);
          }
          return c.json({ error: 'File not found' }, 404);
        }
      }
    }

    if (resolvedPaths.length === 0) {
      return c.json({ error: 'No valid .md files to watch' }, 400);
    }

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    for (const resolved of resolvedPaths) {
      if (!fileWatchers.has(resolved)) {
        const clients = new Set<WritableStreamDefaultWriter>();
        let debounce: ReturnType<typeof setTimeout> | null = null;
        let lastBroadcast: string | null = null;

        const broadcastChange = async () => {
          try {
            const content = await readFile(resolved, 'utf-8');
            if (lastWrittenContent.get(resolved) === content) return;
            if (content === lastBroadcast) return;
            const extComments = (content.match(/@comment\{/g) ?? []).length;
            const prevComments = (lastBroadcast?.match(/@comment\{/g) ?? []).length;
            console.warn(
              `[EXTERNAL CHANGE] ${resolved} — ${extComments} comment(s) (was ${prevComments})`,
            );
            lastWrittenContent.delete(resolved);
            lastBroadcast = content;
            const fileStat = await stat(resolved);
            const frame = sseFrame(
              'change',
              JSON.stringify({ content, path: resolved, mtime: fileStat.mtimeMs }),
            );
            for (const client of clients) {
              client.write(frame).catch(() => {
                clients.delete(client);
              });
            }
          } catch {
            const frame = sseFrame(
              'error',
              JSON.stringify({ path: resolved, reason: 'file_gone' }),
            );
            for (const client of clients) {
              client.write(frame).catch(() => {
                clients.delete(client);
              });
            }
            cleanUpWatcher();
          }
        };

        const onFsEvent = (eventType: string) => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(async () => {
            await broadcastChange();
            // On macOS, fs.watch uses kqueue which tracks by file descriptor.
            // Atomic writes (rename-over) create a new inode, leaving the old
            // watcher stale.  Re-attach after every rename so we keep watching
            // the current file.
            if (eventType === 'rename') {
              reattachWatcher();
            }
          }, 150);
        };

        let activeWatcher = watch(resolved, onFsEvent);

        const reattachWatcher = () => {
          activeWatcher.close();
          try {
            activeWatcher = watch(resolved, onFsEvent);
            activeWatcher.on('error', cleanUpWatcher);
            const entry = fileWatchers.get(resolved);
            if (entry) entry.watcher = activeWatcher;
          } catch {
            // File deleted — clean up entirely
            cleanUpWatcher();
          }
        };

        const cleanUpWatcher = () => {
          if (debounce) {
            clearTimeout(debounce);
            debounce = null;
          }
          for (const client of clients) {
            client.close().catch(() => {});
          }
          clients.clear();
          activeWatcher.close();
          fileWatchers.delete(resolved);
          lastWrittenContent.delete(resolved);
        };

        activeWatcher.on('error', cleanUpWatcher);
        fileWatchers.set(resolved, { watcher: activeWatcher, clients, cleanup: cleanUpWatcher });
      }

      const entry = fileWatchers.get(resolved)!;
      entry.clients.add(writer);
    }

    for (const resolved of resolvedPaths) {
      writer.write(sseFrame('connected', JSON.stringify({ path: resolved }))).catch(() => {});
    }

    c.req.raw.signal.addEventListener('abort', () => {
      for (const resolved of resolvedPaths) {
        const entry = fileWatchers.get(resolved);
        if (!entry) continue;
        entry.clients.delete(writer);
        if (entry.clients.size === 0) {
          entry.cleanup();
        }
      }
      writer.close().catch(() => {});
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
          const escaped = resolved.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          execFileImpl(
            'osascript',
            [
              '-e',
              `tell application "Finder" to reveal POSIX file "${escaped}"`,
              '-e',
              'tell application "Finder" to activate',
            ],
            (err) => {
              if (err) return reject(err);
              promiseResolve();
            },
          );
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

const DEFAULT_PORT = Number.parseInt(process.env.MD_REDLINE_PORT ?? process.env.PORT ?? '3001', 10);
const MAX_PORT_ATTEMPTS = 10;
const PORT_FILE = join(tmpdir(), 'md-redline.port');

function tryListen(appFetch: typeof app.fetch, port: number): Promise<number> {
  return new Promise((res, rej) => {
    const server = serve({ fetch: appFetch, port, hostname: '127.0.0.1' }, () => res(port));
    server.on('error', (err: NodeJS.ErrnoException) => {
      rej(err);
    });
  });
}

async function findAvailablePort(appFetch: typeof app.fetch): Promise<number> {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + MAX_PORT_ATTEMPTS; p++) {
    try {
      return await tryListen(appFetch, p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(
    `No available port found (tried ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1})`,
  );
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  findAvailablePort(app.fetch)
    .then(async (port) => {
      // Write port file safely: use O_EXCL to prevent symlink clobber attacks.
      // If the file already exists (previous unclean exit), unlink it first
      // to avoid following a symlink that may have replaced the stale file.
      try {
        const fd = await open(PORT_FILE, 'wx');
        await fd.writeFile(String(port));
        await fd.close();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          unlinkSync(PORT_FILE);
          const fd = await open(PORT_FILE, 'wx');
          await fd.writeFile(String(port));
          await fd.close();
        } else {
          throw e;
        }
      }
      console.log(`md-redline server running on http://localhost:${port}`);
      const initialArg = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : '';
      if (initialArg) {
        console.log(`Initial path: ${initialArg}`);
      }

      const cleanup = () => {
        try {
          unlinkSync(PORT_FILE);
        } catch {
          /* ignore */
        }
      };
      process.on('exit', cleanup);
      process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
      });
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
