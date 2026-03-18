import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, extname, resolve, dirname } from 'path';
import { homedir } from 'os';

const app = new Hono();

app.use('*', cors());

const initialFile = process.argv[2] ? resolve(process.argv[2]) : '';

app.get('/api/config', (c) => {
  return c.json({ initialFile });
});

app.get('/api/file', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query parameter is required' }, 400);

  try {
    const resolved = resolve(path);
    const content = await readFile(resolved, 'utf-8');
    return c.json({ content, path: resolved });
  } catch {
    return c.json({ error: 'File not found or not readable' }, 404);
  }
});

app.put('/api/file', async (c) => {
  const body = await c.req.json<{ path: string; content: string }>();
  if (!body.path || body.content === undefined) {
    return c.json({ error: 'path and content are required' }, 400);
  }

  try {
    const resolved = resolve(body.path);
    await writeFile(resolved, body.content, 'utf-8');
    return c.json({ success: true, path: resolved });
  } catch {
    return c.json({ error: 'Failed to write file' }, 500);
  }
});

app.get('/api/files', async (c) => {
  const dir = c.req.query('dir') || process.cwd();

  try {
    const resolved = resolve(dir);
    const entries = await readdir(resolved, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && extname(e.name) === '.md')
      .map((e) => join(resolved, e.name));
    return c.json({ files, dir: resolved });
  } catch {
    return c.json({ error: 'Directory not found' }, 404);
  }
});

app.get('/api/browse', async (c) => {
  const dir = c.req.query('dir') || process.cwd();

  try {
    const resolved = resolve(dir);
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

    return c.json({
      dir: resolved,
      parent: parent !== resolved ? parent : null,
      directories,
      files,
      home: homedir(),
    });
  } catch {
    return c.json({ error: 'Directory not found or not accessible' }, 404);
  }
});

const port = 3001;
serve({ fetch: app.fetch, port }, () => {
  console.log(`md-commenter server running on http://localhost:${port}`);
  if (initialFile) {
    console.log(`Initial file: ${initialFile}`);
  }
});
