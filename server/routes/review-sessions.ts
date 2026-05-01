import type { Hono } from 'hono';
import { extname } from 'path';
import type { ReviewSessionStore } from '../review-sessions';

/**
 * Register the seven HTTP endpoints that expose a ReviewSessionStore over
 * the Hono app. Extracted from server/index.ts so the index file doesn't
 * have to own every route.
 *
 * All file-path validation goes through the caller-supplied
 * `resolveAndValidate` closure so allowed-roots enforcement stays
 * centralized in createApp.
 */
export function registerReviewSessionRoutes(
  app: Hono,
  reviewSessions: ReviewSessionStore,
  resolveAndValidate: (path: string) => Promise<string>,
): void {
  app.post('/api/review-sessions', async (c) => {
    let body: { filePaths?: unknown; enableResolve?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { filePaths, enableResolve } = body;
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return c.json({ error: 'filePaths must be a non-empty array' }, 400);
    }
    if (filePaths.some((p) => typeof p !== 'string' || p.length === 0)) {
      return c.json({ error: 'filePaths must contain non-empty strings' }, 400);
    }

    const resolved: string[] = [];
    for (const p of filePaths) {
      try {
        const r = await resolveAndValidate(p as string);
        if (extname(r).toLowerCase() !== '.md') {
          return c.json({ error: `Not a .md file: ${p}` }, 400);
        }
        resolved.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid path';
        if (msg.startsWith('Access denied')) {
          return c.json({ error: msg }, 403);
        }
        return c.json({ error: msg }, 400);
      }
    }

    // Deduplicate: if an open session for the same files already exists,
    // return it instead of creating a new one. This prevents double browser
    // tabs when the tool is called twice for the same files.
    const existing = reviewSessions.findOpenSession(resolved);
    if (existing) {
      console.log(
        `[review-session] reusing ${existing.id} for ${resolved.length} file(s): ${resolved.join(', ')}`,
      );
      return c.json({
        sessionId: existing.id,
        url: `/?review=${encodeURIComponent(existing.id)}`,
        created: false,
      });
    }

    const session = reviewSessions.createSession({
      filePaths: resolved,
      enableResolve: enableResolve === true,
    });

    console.log(
      `[review-session] created ${session.id} for ${resolved.length} file(s): ${resolved.join(', ')}`,
    );

    return c.json(
      {
        sessionId: session.id,
        url: `/?review=${encodeURIComponent(session.id)}`,
        created: true,
      },
      201,
    );
  });

  app.get('/api/review-sessions', (c) => {
    return c.json({ sessions: reviewSessions.listOpenSessions() });
  });

  app.get('/api/review-sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = reviewSessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session);
  });

  app.post('/api/review-sessions/:id/batch', async (c) => {
    const id = c.req.param('id');
    let body: { prompt?: unknown; commentIds?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'prompt must be a non-empty string' }, 400);
    }
    if (!Array.isArray(body.commentIds) || body.commentIds.length === 0) {
      return c.json({ error: 'commentIds must be a non-empty array' }, 400);
    }
    if (body.commentIds.some((id) => typeof id !== 'string')) {
      return c.json({ error: 'commentIds must contain strings' }, 400);
    }
    if (!reviewSessions.getSession(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const ok = reviewSessions.sendBatch(id, body.prompt, body.commentIds as string[]);
    if (!ok) {
      const session = reviewSessions.getSession(id);
      if (session?.waitingForAgent) {
        return c.json({ error: 'Agent has not picked up the previous batch yet' }, 409);
      }
      return c.json({ error: 'Session is not open' }, 409);
    }
    console.log(`[review-session] batch sent for ${id} (${(body.commentIds as string[]).length} comments)`);
    return c.json({ ok: true });
  });

  app.post('/api/review-sessions/:id/finish', async (c) => {
    const id = c.req.param('id');
    let body: { prompt?: unknown; commentIds?: unknown } = {};
    try {
      const raw = await c.req.text();
      if (raw.trim().length > 0) {
        body = JSON.parse(raw);
      }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!reviewSessions.getSession(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const prompt = typeof body.prompt === 'string' && body.prompt.length > 0 ? body.prompt : undefined;
    const commentIds = Array.isArray(body.commentIds)
      ? (body.commentIds.filter((id): id is string => typeof id === 'string') as string[])
      : undefined;
    const ok = reviewSessions.finish(id, prompt, commentIds);
    if (!ok) {
      return c.json({ error: 'Session is not open' }, 409);
    }
    console.log(`[review-session] finished ${id}${prompt ? ` (${prompt.length} chars)` : ' (no final comments)'}`);
    return c.json({ ok: true });
  });

  app.post('/api/review-sessions/:id/abort', (c) => {
    const id = c.req.param('id');
    if (!reviewSessions.getSession(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const ok = reviewSessions.abort(id, 'user_cancelled');
    if (!ok) {
      return c.json({ error: 'Session is not open' }, 409);
    }
    console.log(`[review-session] aborted ${id} (user_cancelled)`);
    return c.json({ ok: true });
  });

  app.post('/api/review-sessions/:id/heartbeat', (c) => {
    const id = c.req.param('id');
    if (!reviewSessions.getSession(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const ok = reviewSessions.heartbeat(id);
    if (!ok) {
      return c.json({ error: 'Session is not open' }, 409);
    }
    return c.json({ ok: true });
  });

  app.get('/api/review-sessions/:id/wait', async (c) => {
    const id = c.req.param('id');
    const session = reviewSessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // waitForSession returns the session's existing waiter promise. If the
    // session is already resolved, the promise is already settled and resolves
    // immediately. If still open, this awaits until batch/finish/abort/sweep.
    const waiterPromise = reviewSessions.waitForSession(id);

    // Optional ?timeout=<seconds> lets polling clients (e.g. Codex, which
    // enforces a 120s hard timeout per tool call) avoid being killed. The
    // endpoint returns {status:'pending'} after the timeout so the client can
    // re-poll without losing the session.
    const timeoutParam = c.req.query('timeout');
    const timeoutMs = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : 0;

    if (timeoutMs > 0) {
      const pending = new Promise<{ status: 'pending' }>((resolve) => {
        const t = setTimeout(() => resolve({ status: 'pending' }), timeoutMs);
        if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
      });
      const result = await Promise.race([waiterPromise, pending]);
      return c.json(result);
    }

    const result = await waiterPromise;
    return c.json(result);
  });
}
