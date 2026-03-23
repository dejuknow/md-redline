import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { readFile, writeFile, readdir, stat, realpath } from 'fs/promises';
import { watch, statSync, type FSWatcher } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { homedir } from 'os';

const app = new Hono();

app.use('*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 })); // 10MB

const arg = process.argv[2] ? resolve(process.argv[2]) : '';

// Determine if the argument is a directory or a file
let initialFile = '';
let initialDir = '';
try {
  const argStat = arg ? statSync(arg) : null;
  if (argStat?.isDirectory()) {
    initialDir = arg;
  } else if (arg) {
    initialFile = arg;
  }
} catch {
  // Doesn't exist yet — treat as file
  if (arg) initialFile = arg;
}

// Allowed base directories: cwd, home, and the initial file/dir (if provided).
const ALLOWED_ROOTS = [resolve(process.cwd()), resolve(homedir())];
if (initialFile) {
  const fileDir = dirname(initialFile);
  if (!ALLOWED_ROOTS.some((r) => fileDir.startsWith(r + '/') || fileDir === r)) {
    ALLOWED_ROOTS.push(fileDir);
  }
}
if (initialDir) {
  if (!ALLOWED_ROOTS.some((r) => initialDir.startsWith(r + '/') || initialDir === r)) {
    ALLOWED_ROOTS.push(initialDir);
  }
}

/** Resolve symlinks and check the real path is within allowed roots. */
async function resolveAndValidate(inputPath: string): Promise<string> {
  const resolved = resolve(inputPath);
  // Resolve symlinks to prevent symlink-based bypass
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    // File doesn't exist yet (e.g. for writes) — use the resolved path
    real = resolved;
  }
  const allowed = ALLOWED_ROOTS.some((root) => real.startsWith(root + '/') || real === root);
  if (!allowed) {
    throw new Error('Access denied: path outside allowed directories');
  }
  return real;
}

function isMdFile(resolved: string): boolean {
  return extname(resolved).toLowerCase() === '.md';
}

// Paths currently being saved by the app (skip triggering SSE reload for our own writes)
const recentWrites = new Set<string>();

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
    // Mark as our own write so the file watcher ignores this change
    recentWrites.add(resolved);
    try {
      await writeFile(resolved, body.content, 'utf-8');
    } finally {
      // Ensure recentWrites is always cleaned up, even if write fails
      setTimeout(() => recentWrites.delete(resolved), 500);
    }
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
  const dir = c.req.query('dir') || process.cwd();

  try {
    const resolved = await resolveAndValidate(dir);
    const entries = await readdir(resolved, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && extname(e.name) === '.md')
      .map((e) => join(resolved, e.name));
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
  const dir = c.req.query('dir') || process.cwd();

  try {
    const resolved = await resolveAndValidate(dir);
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return c.json({ error: 'Not a directory' }, 400);
    }

    const entries = await readdir(resolved, { withFileTypes: true });

    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = entries
      .filter((e) => e.isFile() && extname(e.name) === '.md')
      .map((e) => ({ name: e.name, path: join(resolved, e.name) }))
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

// --- SSE file watcher ---
const sseEncoder = new TextEncoder();

/** Encode an SSE frame. Newlines in `data` are split into separate `data:` lines per the SSE spec. */
function sseFrame(event: string, data: string): Uint8Array {
  const lines = data.split('\n');
  const frame = `event: ${event}\n${lines.map((l) => `data: ${l}`).join('\n')}\n\n`;
  return sseEncoder.encode(frame);
}

// Track active watchers per file path, and connected SSE clients
const fileWatchers = new Map<
  string,
  { watcher: FSWatcher; clients: Set<WritableStreamDefaultWriter> }
>();

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

  // Register this client (create watcher on first connect)
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
      if (recentWrites.has(resolved)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try {
          const content = await readFile(resolved, 'utf-8');
          const frame = sseFrame('change', JSON.stringify({ content, path: resolved }));
          for (const client of clients) {
            client.write(frame).catch(() => {});
          }
        } catch {
          // File became unreadable (deleted/moved) — notify clients and clean up
          const frame = sseFrame('error', JSON.stringify({ path: resolved, reason: 'file_gone' }));
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

  // Send initial connected event
  writer.write(sseFrame('connected', JSON.stringify({ path: resolved }))).catch(() => {});

  // Clean up on disconnect
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

const port = 3001;
serve({ fetch: app.fetch, port }, () => {
  console.log(`md-review server running on http://localhost:${port}`);
  if (initialFile) {
    console.log(`Initial file: ${initialFile}`);
  }
});
