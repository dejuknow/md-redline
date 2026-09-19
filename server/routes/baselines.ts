import type { Hono } from 'hono';
import { readFile, stat } from 'fs/promises';
import type { Stats } from 'fs';
import { extname } from 'path';
import { BaselineStore, MAX_BASELINE_BYTES, MAX_BASELINES } from '../baselines';

export interface BaselineRoutesDeps {
  /** Same closure the review-session routes use; enforces allowed roots. */
  resolveAndValidate: (path: string) => Promise<string>;
}

const MAX_AGENT_NAME_LEN = 64;

type PathFailure = { status: 400 | 403 | 413; error: string };

/**
 * `/api/baselines`: the server-held "before" copies behind `mdr_baseline`.
 *
 * POST validates every path and reads every file before touching the store,
 * so a mixed batch either lands whole or not at all. The server reads from
 * disk itself: the copy is exact, and nothing large crosses the MCP
 * transport. GET list is metadata only so the browser can poll it cheaply;
 * GET content is fetched per path only when the browser needs it.
 */
export function registerBaselineRoutes(
  app: Hono,
  store: BaselineStore,
  deps: BaselineRoutesDeps,
): void {
  const { resolveAndValidate } = deps;

  async function resolveMarkdownPath(
    input: string,
  ): Promise<{ ok: true; path: string } | { ok: false; failure: PathFailure }> {
    let resolved: string;
    try {
      resolved = await resolveAndValidate(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid path';
      return {
        ok: false,
        failure: { status: msg.startsWith('Access denied') ? 403 : 400, error: `${msg}: ${input}` },
      };
    }
    if (extname(resolved).toLowerCase() !== '.md') {
      return { ok: false, failure: { status: 400, error: `Not a .md file: ${input}` } };
    }
    return { ok: true, path: resolved };
  }

  /** ENOENT means "not created yet" (null, keep going); anything else is a failure. */
  function readFailure(err: unknown, p: string): PathFailure | null {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'EACCES' || code === 'EPERM') {
      return { status: 403, error: `Permission denied: ${p}` };
    }
    return { status: 400, error: `Could not read ${p}` };
  }

  app.post('/api/baselines', async (c) => {
    let body: { filePaths?: unknown; agentName?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const { filePaths, agentName } = body;
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return c.json({ error: 'filePaths must be a non-empty array' }, 400);
    }
    if (filePaths.some((p) => typeof p !== 'string' || p.length === 0)) {
      return c.json({ error: 'filePaths must contain non-empty strings' }, 400);
    }
    if (filePaths.length > MAX_BASELINES) {
      return c.json({ error: `At most ${MAX_BASELINES} files per call` }, 400);
    }
    if (agentName !== undefined) {
      if (
        typeof agentName !== 'string' ||
        agentName.length === 0 ||
        agentName.length > MAX_AGENT_NAME_LEN
      ) {
        return c.json(
          { error: `agentName must be a non-empty string of at most ${MAX_AGENT_NAME_LEN} chars` },
          400,
        );
      }
    }

    const tooLarge = (p: string) =>
      c.json({ error: `File too large to baseline (max ${MAX_BASELINE_BYTES} bytes): ${p}` }, 413);

    const captured: Array<{ path: string; content: string }> = [];
    for (const p of filePaths as string[]) {
      const r = await resolveMarkdownPath(p);
      if (!r.ok) return c.json({ error: r.failure.error }, r.failure.status);
      // A path that does not exist yet (its parent does, or resolveAndValidate
      // would have refused it) is a file the agent is about to create: its
      // before state is empty, so the whole new file will diff as added.
      let content = '';
      let info: Stats | null = null;
      try {
        info = await stat(r.path);
      } catch (err) {
        const failure = readFailure(err, p);
        if (failure) return c.json({ error: failure.error }, failure.status);
      }
      if (info) {
        if (!info.isFile()) return c.json({ error: `Not a file: ${p}` }, 400);
        if (info.size > MAX_BASELINE_BYTES) return tooLarge(p);
        try {
          content = await readFile(r.path, 'utf8');
        } catch (err) {
          const failure = readFailure(err, p);
          if (failure) return c.json({ error: failure.error }, failure.status);
        }
        // The file can grow between stat and read.
        if (Buffer.byteLength(content, 'utf8') > MAX_BASELINE_BYTES) return tooLarge(p);
      }
      captured.push({ path: r.path, content });
    }

    const baselines = captured.map(({ path, content }) =>
      store.set({ path, content, ...(agentName !== undefined ? { agentName } : {}) }),
    );
    console.log(
      `[baseline] captured ${baselines.length} file(s): ${baselines.map((b) => b.path).join(', ')}`,
    );
    return c.json({ baselines }, 201);
  });

  app.get('/api/baselines', (c) => {
    return c.json({ baselines: store.list() });
  });

  app.get('/api/baselines/content', async (c) => {
    const raw = c.req.query('path');
    if (!raw) return c.json({ error: 'path query parameter is required' }, 400);
    const r = await resolveMarkdownPath(raw);
    if (!r.ok) return c.json({ error: r.failure.error }, r.failure.status);
    const baseline = store.get(r.path);
    if (!baseline) return c.json({ error: `No baseline for ${raw}` }, 404);
    return c.json(baseline);
  });
}
