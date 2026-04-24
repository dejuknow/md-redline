import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { readFile, readdir, stat, realpath, rename, open } from 'fs/promises';
import { randomBytes } from 'crypto';
import { watch, statSync, realpathSync, unlinkSync, type FSWatcher } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { homedir, platform, tmpdir } from 'os';
import { execFile } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  addTrustedRoot,
  readPreferences,
  readPreferencesSync,
  writePreferences,
} from './preferences';
import { injectSvgDimensions } from './svg-dimensions';
import { ReviewSessionStore } from './review-sessions';
import { registerReviewSessionRoutes } from './routes/review-sessions';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json') as { version: string };

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

export interface CreateAppOptions {
  cwd?: string;
  execFileImpl?: typeof execFile;
  homeDir?: string;
  initialArg?: string;
  platformName?: NodeJS.Platform;
  staticDir?: string;
  defaultTrustHome?: boolean;
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

const MAX_ALLOWED_ROOTS = 50;
const MAX_WRITTEN_CACHE = 100;
// Hard cap on file sizes the server is willing to load fully into memory.
// Markdown files in real review workflows are far below this; the cap
// exists to keep a runaway file (gigabyte log accidentally renamed to .md,
// adversarial trusted-root content) from OOMing the server on /api/file
// or repeated watcher reads.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
  // Host header allowlist — closes DNS rebinding. The server only binds to
  // 127.0.0.1, so any request reaching us either came from a localhost-
  // bound caller (curl, Vite proxy, the SPA itself) OR from a browser whose
  // DNS resolver returned 127.0.0.1 for an attacker-controlled hostname.
  // The CORS allowlist blocks cross-origin JS reads but does NOT prevent
  // simple GETs from triggering server side effects, and does NOT prevent
  // a rebinding attack where the attacker site IS the active origin.
  // Verifying the Host header is loopback closes that gap.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    // A missing Host header can only come from an internal in-process
    // caller (test harness, programmatic app.fetch) — never from a real
    // browser, which always sets Host. Allow it through. The threat model
    // here is browser-driven DNS rebinding; an in-process caller already
    // has full code execution and there's nothing to defend against.
    if (host) {
      // Strip an optional port. IPv6 hosts arrive as `[::1]:3001`.
      const hostname = host.startsWith('[')
        ? host.slice(1, host.indexOf(']'))
        : host.split(':')[0];
      if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
        return c.json({ error: 'Invalid Host header' }, 400);
      }
    }
    await next();
  });
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

  // Hydrate allowedRoots from persisted trustedRoots in preferences. This
  // restores folders the user previously consented to via /api/pick-file
  // across server restarts. Stale entries are pruned from disk.
  const persistedPrefs = readPreferencesSync(homeDir);
  let persistedRoots = persistedPrefs.trustedRoots;
  let migratedFromRecent = false;

  // First-launch seed: when trustedRoots has never been written, the
  // production server seeds the user's home directory by default so the
  // tool works like a normal editor for the typical single-user case. The
  // recentFiles migration ALSO runs in this branch so existing users
  // upgrading from a version without trustedRoots get their previously-
  // opened files trusted automatically. Triggered by `trustedRoots ===
  // undefined`; once we write the field (even as []), this never re-runs.
  if (persistedRoots === undefined) {
    const seen = new Set<string>();
    const derived: string[] = [];

    if (options.defaultTrustHome) {
      let canonHome: string;
      try {
        canonHome = realpathSync(homeDir);
      } catch {
        canonHome = homeDir;
      }
      if (!seen.has(canonHome)) {
        seen.add(canonHome);
        derived.push(canonHome);
      }
    }

    if (persistedPrefs.recentFiles?.length) {
      for (const recent of persistedPrefs.recentFiles) {
        let canon: string;
        try {
          canon = realpathSync(dirname(recent.path));
        } catch {
          continue;
        }
        if (seen.has(canon)) continue;
        seen.add(canon);
        derived.push(canon);
      }
    }

    if (derived.length > 0) {
      persistedRoots = derived;
      migratedFromRecent = true;
    }
  }
  persistedRoots = persistedRoots ?? [];

  const survivingRoots: string[] = [];
  for (const persisted of persistedRoots) {
    let canon: string;
    try {
      canon = realpathSync(persisted);
    } catch {
      continue;
    }
    survivingRoots.push(canon);
    if (allowedRoots.length >= MAX_ALLOWED_ROOTS) continue;
    if (allowedRoots.some((root) => isPathInsideRoot(canon, root, caseInsensitivePaths))) {
      continue;
    }
    allowedRoots.push(canon);
  }

  const prunedSomething =
    survivingRoots.length !== persistedRoots.length ||
    survivingRoots.some((p, i) => p !== persistedRoots[i]);
  if (migratedFromRecent || prunedSomething) {
    void writePreferences(homeDir, { trustedRoots: survivingRoots }).catch((err) => {
      console.error('Failed to persist trustedRoots:', err);
    });
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
      // The 'Access denied' prefix is part of the client contract: the
      // frontend's isAccessDeniedError helper (src/hooks/useTabs.ts) keys
      // off it to render the trust button. Don't change without updating
      // both call sites.
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

  const reviewSessions = new ReviewSessionStore();
  reviewSessions.startSweep(10_000);

  registerReviewSessionRoutes(app, reviewSessions, resolveAndValidate);

  app.get('/api/config', (c) => {
    return c.json({ initialFile, initialDir, homeDir });
  });

  app.get('/api/version', (c) => {
    return c.json({ version: APP_VERSION });
  });

  app.post('/api/shutdown', (c) => {
    setImmediate(() => process.exit(0));
    return c.json({ ok: true });
  });

  app.post('/api/grant-access', async (c) => {
    let body: { path?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const inputPath = body?.path;
    if (!inputPath || typeof inputPath !== 'string') {
      return c.json({ error: 'Missing path' }, 400);
    }
    const expanded = expandHomePath(inputPath, homeDir);
    const resolved = resolve(cwd, expanded);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      try {
        real = await realpath(dirname(resolved));
      } catch {
        return c.json({ error: 'Path does not exist' }, 404);
      }
    }
    const canon = canonicalize(real);
    // Only allow granting access to paths within existing allowed roots.
    // This prevents a cross-origin attacker from escalating to arbitrary
    // filesystem paths via a rogue localhost process.
    const withinExisting = allowedRoots.some((root) =>
      isPathInsideRoot(canon, root, caseInsensitivePaths),
    );
    if (!withinExisting) {
      return c.json({ error: 'Cannot grant access outside allowed directories' }, 403);
    }
    return c.json({ granted: canon });
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
      // Use a file descriptor so content and mtime are read from the
      // same inode, preventing a TOCTOU race where an external write
      // between readFile and stat yields mismatched content/mtime.
      const fd = await open(resolved, 'r');
      try {
        const fileStat = await fd.stat();
        if (fileStat.size > MAX_FILE_BYTES) {
          return c.json(
            {
              error: `File too large to open (${fileStat.size} bytes; limit ${MAX_FILE_BYTES})`,
            },
            413,
          );
        }
        const content = await fd.readFile('utf-8');
        return c.json({ content, path: resolved, mtime: fileStat.mtimeMs });
      } finally {
        await fd.close();
      }
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
          // Use a random suffix to prevent DoS from a stale or adversarial
          // .tmp file blocking saves, and O_EXCL to prevent symlink attacks.
          const tmpPath = `${resolved}.${randomBytes(6).toString('hex')}.tmp`;
          const fd = await open(tmpPath, 'wx');
          try {
            await fd.writeFile(body.content, 'utf-8');
          } finally {
            await fd.close();
          }
          await rename(tmpPath, resolved);
          lastWrittenContent.set(resolved, body.content);
          // LRU eviction: cap cache size to prevent unbounded memory growth
          if (lastWrittenContent.size > MAX_WRITTEN_CACHE) {
            const oldest = lastWrittenContent.keys().next().value!;
            lastWrittenContent.delete(oldest);
          }
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

  app.get('/api/asset', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);

    try {
      const resolved = await resolveAndValidate(path);
      const ext = extname(resolved).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return c.json({ error: 'Unsupported asset type' }, 400);
      }
      const assetStat = await stat(resolved);
      if (assetStat.size > MAX_FILE_BYTES) {
        return c.json(
          { error: `Asset too large (${assetStat.size} bytes; limit ${MAX_FILE_BYTES})` },
          413,
        );
      }
      const headers: Record<string, string> = {
        'Content-Type': IMAGE_MIME_TYPES[ext],
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      };
      // SVG safety: when loaded via <img src>, browsers block embedded
      // scripts. But if the user opens the SVG directly in a new tab
      // (middle-click, crafted target="_blank"), scripts execute on our
      // origin. The CSP sandbox + script-src 'none' prevent this.
      if (ext === '.svg') {
        headers['Content-Security-Policy'] =
          "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      }
      if (ext === '.svg') {
        // For SVGs that have a viewBox but no explicit width/height, inject
        // dimensions derived from the viewBox so the browser renders them
        // at their natural pixel size instead of stretching to fill the
        // container.
        const content = injectSvgDimensions(await readFile(resolved));
        return new Response(content, { headers });
      }
      const content = await readFile(resolved);
      return new Response(content, { headers });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        return c.json({ error: err.message }, 403);
      }
      console.error('GET /api/asset failed:', err);
      return c.json({ error: 'File not found or not readable' }, 404);
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
    const defaultPath = c.req.query('defaultPath') ?? '';
    try {
      const path = await new Promise<string>((promiseResolve, reject) => {
        if (platformName === 'darwin') {
          // AppleScript string literal: backslash-escape \ and " in the path.
          const escaped = defaultPath
            ? defaultPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            : '';
          const defaultClause = escaped ? ` default location POSIX file "${escaped}"` : '';
          execFileImpl(
            'osascript',
            [
              '-e',
              `set f to POSIX path of (choose file of type {"md", "markdown", "public.plain-text"} with prompt "Choose a markdown file"${defaultClause})`,
              '-e',
              'return f',
            ],
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'linux') {
          // zenity --filename takes a separate argv, no shell interpolation needed.
          const args = [
            '--file-selection',
            '--title=Choose a markdown file',
            '--file-filter=Markdown files | *.md *.markdown',
          ];
          if (defaultPath) args.push(`--filename=${defaultPath}`);
          execFileImpl(
            'zenity',
            args,
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'win32') {
          // PowerShell single-quoted strings escape ' by doubling.
          const escaped = defaultPath ? defaultPath.replace(/'/g, "''") : '';
          const initialClause = escaped
            ? `$dialog.FileName = '${escaped}'; $dialog.InitialDirectory = (Split-Path -Parent '${escaped}'); `
            : '';
          execFileImpl(
            'powershell',
            [
              '-NoProfile',
              '-STA',
              '-Command',
              `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Filter = "Markdown files (*.md;*.markdown)|*.md;*.markdown|All files (*.*)|*.*"; ${initialClause}if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }`,
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
      // Grant access to the file's directory so subsequent API calls work,
      // and persist the grant so it survives server restarts.
      const pickedDir = dirname(resolve(path));
      let persistedDir: string | null = null;
      try {
        const realDir = canonicalize(pickedDir);
        if (
          allowedRoots.length < MAX_ALLOWED_ROOTS &&
          !allowedRoots.some((root) => isPathInsideRoot(realDir, root, caseInsensitivePaths))
        ) {
          allowedRoots.push(realDir);
        }
        persistedDir = realDir;
      } catch {
        // Can't canonicalize — add the raw resolved dir.
        if (
          allowedRoots.length < MAX_ALLOWED_ROOTS &&
          !allowedRoots.some((root) => isPathInsideRoot(pickedDir, root, caseInsensitivePaths))
        ) {
          allowedRoots.push(pickedDir);
        }
        persistedDir = pickedDir;
      }
      if (persistedDir) {
        void addTrustedRoot(homeDir, persistedDir).catch((err) => {
          console.error('Failed to persist new trustedRoot:', err);
        });
      }
      return c.json({ path });
    } catch {
      return c.json({ cancelled: true });
    }
  });

  app.get('/api/pick-folder', async (c) => {
    const defaultPath = c.req.query('defaultPath') ?? '';
    try {
      const path = await new Promise<string>((promiseResolve, reject) => {
        if (platformName === 'darwin') {
          // AppleScript string literal: backslash-escape \ and " in the path.
          const escaped = defaultPath
            ? defaultPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            : '';
          const defaultClause = escaped ? ` default location POSIX file "${escaped}"` : '';
          execFileImpl(
            'osascript',
            [
              '-e',
              `set f to POSIX path of (choose folder with prompt "Allow md-redline to access this folder"${defaultClause})`,
              '-e',
              'return f',
            ],
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'linux') {
          // zenity --directory + --filename takes separate argv, no shell interpolation needed.
          const args = [
            '--file-selection',
            '--directory',
            '--title=Allow md-redline to access this folder',
          ];
          if (defaultPath) args.push(`--filename=${defaultPath}/`);
          execFileImpl(
            'zenity',
            args,
            (err, stdout) => {
              if (err) return reject(err);
              promiseResolve(stdout.trim());
            },
          );
        } else if (platformName === 'win32') {
          // PowerShell single-quoted strings escape ' by doubling.
          const escaped = defaultPath ? defaultPath.replace(/'/g, "''") : '';
          const initialClause = escaped ? `$dialog.SelectedPath = '${escaped}'; ` : '';
          execFileImpl(
            'powershell',
            [
              '-NoProfile',
              '-STA',
              '-Command',
              `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Allow md-redline to access this folder"; ${initialClause}if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }`,
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
      if (!path) return c.json({ error: 'No folder selected' }, 400);

      // Resolve and validate that it's actually a directory.
      const resolved = resolve(path);
      let realDir: string;
      try {
        realDir = canonicalize(resolved);
      } catch {
        realDir = resolved;
      }
      try {
        const dirStat = statSync(realDir);
        if (!dirStat.isDirectory()) {
          return c.json({ error: 'Picked path is not a directory' }, 400);
        }
      } catch {
        return c.json({ error: 'Picked path does not exist' }, 400);
      }

      // Grant access and persist.
      if (
        allowedRoots.length < MAX_ALLOWED_ROOTS &&
        !allowedRoots.some((root) => isPathInsideRoot(realDir, root, caseInsensitivePaths))
      ) {
        allowedRoots.push(realDir);
      }
      void addTrustedRoot(homeDir, realDir).catch((err) => {
        console.error('Failed to persist new trustedRoot:', err);
      });

      return c.json({ path: realDir });
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
            const watchStat = await stat(resolved);
            if (watchStat.size > MAX_FILE_BYTES) {
              // Don't load gigabyte-scale files into memory on every fs
              // event. Surface the same "file_gone" channel so the client
              // shows an error rather than silently stalling.
              const frame = sseFrame(
                'error',
                JSON.stringify({ path: resolved, reason: 'too_large' }),
              );
              for (const client of clients) {
                client.write(frame).catch(() => {
                  clients.delete(client);
                });
              }
              return;
            }
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
          // Use 'on run argv' to pass the path as an argument instead of
          // interpolating it into AppleScript source, eliminating any
          // injection surface from exotic path characters.
          execFileImpl(
            'osascript',
            [
              '-e', 'on run argv',
              '-e', 'tell application "Finder" to reveal (POSIX file (item 1 of argv) as alias)',
              '-e', 'tell application "Finder" to activate',
              '-e', 'end run',
              resolved,
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

  // Production static file serving — MUST be last, the GET * wildcard shadows later GET routes
  const staticDir = options.staticDir;
  if (staticDir) {
    const resolvedStaticDir = resolve(staticDir);
    const indexPath = join(resolvedStaticDir, 'index.html');

    app.get('/__mdr__', (c) => c.text('mdr'));

    app.get('*', async (c) => {
      const urlPath = c.req.path;
      if (urlPath.startsWith('/api/')) {
        return c.json({ error: 'Not Found' }, 404);
      }
      const filePath = resolve(join(resolvedStaticDir, urlPath === '/' ? 'index.html' : urlPath.slice(1)));
      if (!filePath.startsWith(resolvedStaticDir)) {
        return new Response('Not Found', { status: 404 });
      }
      const CSP_HTML =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
      try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        return new Response(content, {
          headers: {
            'Content-Type': mime,
            ...(ext === '.html'
              ? { 'Content-Security-Policy': CSP_HTML }
              : { 'Cache-Control': 'public, max-age=31536000, immutable' }),
          },
        });
      } catch {
        // SPA fallback
        const html = await readFile(indexPath);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP_HTML },
        });
      }
    });
  }

  return app;
}

// Auto-detect production mode: if index.html exists next to this file, serve it
function detectStaticDir(): string | undefined {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const candidatePath = join(serverDir, 'index.html');
  try {
    statSync(candidatePath);
    return serverDir;
  } catch {
    return undefined;
  }
}

export const app = createApp({ staticDir: detectStaticDir(), defaultTrustHome: true });

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
