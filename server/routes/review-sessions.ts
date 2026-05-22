import { randomUUID } from 'crypto';
import type { Hono } from 'hono';
import { extname } from 'path';
import type { ReviewSessionStore } from '../review-sessions';
import { insertComment, removeComment } from '../../src/lib/comment-parser';

/**
 * Register the seven HTTP endpoints that expose a ReviewSessionStore over
 * the Hono app. Extracted from server/index.ts so the index file doesn't
 * have to own every route.
 *
 * All file-path validation goes through the caller-supplied
 * `resolveAndValidate` closure so allowed-roots enforcement stays
 * centralized in createApp.
 */
export interface ReviewSessionRoutesDeps {
  resolveAndValidate: (path: string) => Promise<string>;
  readFileText: (resolvedPath: string) => Promise<string>;
  writeFileText: (resolvedPath: string, content: string) => Promise<void>;
  notifyFileChanged: (resolvedPath: string) => void;
}

export function registerReviewSessionRoutes(
  app: Hono,
  reviewSessions: ReviewSessionStore,
  deps: ReviewSessionRoutesDeps,
): void {
  const { resolveAndValidate, readFileText, writeFileText, notifyFileChanged } = deps;
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
        // Agent is busy. Queue the batch for delivery on the next poll.
        const queued = reviewSessions.queueBatch(id, body.prompt, body.commentIds as string[]);
        if (!queued) {
          return c.json({ error: 'Session is not open' }, 409);
        }
        console.log(`[review-session] batch queued for ${id} (${(body.commentIds as string[]).length} comments)`);
        return c.json({ ok: true, queued: true });
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
    const pending = reviewSessions.getPendingAsks(id);
    if (pending.length > 0) {
      return c.json(
        { error: 'cannot finish review while agent questions are pending; reply or cancel first' },
        409,
      );
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

  app.post('/api/review-sessions/:id/agent-comments', async (c) => {
    const id = c.req.param('id');
    const session = reviewSessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (session.status !== 'open') {
      return c.json({ error: 'session not found or already finished' }, 409);
    }

    let body: { questions?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const { questions } = body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return c.json({ error: 'questions must be a non-empty array' }, 400);
    }

    // Validate each question shape and resolve file paths against allowed roots.
    const resolved: Array<{
      originalIndex: number;
      commentId: string;
      filePath: string;
      anchor: string;
      text: string;
      contextBefore?: string;
      contextAfter?: string;
    }> = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as {
        filePath?: unknown;
        anchor?: unknown;
        text?: unknown;
        contextBefore?: unknown;
        contextAfter?: unknown;
      };
      if (typeof q.filePath !== 'string' || typeof q.anchor !== 'string' || typeof q.text !== 'string') {
        return c.json({ error: `question ${i}: filePath, anchor, text must be strings` }, 400);
      }
      let canonicalPath: string;
      try {
        canonicalPath = await resolveAndValidate(q.filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid path';
        return c.json({ error: `question ${i}: ${msg}` }, 400);
      }
      if (!session.filePaths.includes(canonicalPath)) {
        return c.json({ error: `question ${i}: filePath not part of this session` }, 400);
      }
      resolved.push({
        originalIndex: i,
        commentId: `cmt_${randomUUID()}`,
        filePath: canonicalPath,
        anchor: q.anchor,
        text: q.text,
        contextBefore: typeof q.contextBefore === 'string' ? q.contextBefore : undefined,
        contextAfter: typeof q.contextAfter === 'string' ? q.contextAfter : undefined,
      });
    }

    // Group by file; insert all markers in a single read-write per file. If any
    // anchor in a file is unresolvable, abort the whole call.
    const byFile = new Map<string, typeof resolved>();
    for (const q of resolved) {
      const list = byFile.get(q.filePath) ?? [];
      list.push(q);
      byFile.set(q.filePath, list);
    }

    type FileWrite = { filePath: string; updated: string };
    const writes: FileWrite[] = [];
    const failedIndices: number[] = [];
    for (const [filePath, qs] of byFile) {
      let content = await readFileText(filePath);
      for (const q of qs) {
        const before = content;
        content = insertComment(
          content,
          q.anchor,
          q.text,
          'Agent',
          q.contextBefore,
          q.contextAfter,
          undefined,
          q.commentId,
          { agentInitiated: true, sessionId: id },
        );
        if (content === before) {
          // insertComment returns input unchanged when anchor is not found.
          failedIndices.push(q.originalIndex);
        }
      }
      writes.push({ filePath, updated: content });
    }

    if (failedIndices.length > 0) {
      return c.json(
        { error: 'one or more anchors could not be located', failedIndices },
        400,
      );
    }

    // Apply writes; if any write fails, surface the error (no partial state
    // beyond what insertComment already produced — for v1 we accept that a
    // multi-file ask with one failed write leaves the earlier file written).
    for (const w of writes) {
      await writeFileText(w.filePath, w.updated);
      notifyFileChanged(w.filePath);
    }

    let askId: string;
    try {
      askId = reviewSessions.addAsk(
        id,
        resolved.map((q) => ({
          commentId: q.commentId,
          filePath: q.filePath,
          anchor: q.anchor,
          text: q.text,
          contextBefore: q.contextBefore,
          contextAfter: q.contextAfter,
        })),
      ).askId;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'addAsk failed' }, 409);
    }
    return c.json({ askId }, 201);
  });

  app.get('/api/review-sessions/:id/asks/:askId/wait', async (c) => {
    const sessionId = c.req.param('id');
    const askId = c.req.param('askId');
    if (!reviewSessions.getSession(sessionId)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const owned = reviewSessions.getPendingAsks(sessionId).some((a) => a.askId === askId);
    if (!owned) {
      return c.json({ error: 'Ask not found' }, 404);
    }
    const waiter = reviewSessions.waitForAsk(askId);
    if (!waiter) {
      return c.json({ error: 'Ask not found' }, 404);
    }
    const result = await waiter;
    return c.json(result);
  });

  app.post('/api/review-sessions/:id/asks/:askId/reply', async (c) => {
    const sessionId = c.req.param('id');
    const askId = c.req.param('askId');
    if (!reviewSessions.getSession(sessionId)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const pending = reviewSessions.getPendingAsks(sessionId).find((a) => a.askId === askId);
    if (!pending) {
      return c.json({ error: 'Ask not found' }, 404);
    }

    let body: { replies?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.replies)) {
      return c.json({ error: 'replies must be an array' }, 400);
    }
    const replies: Array<{ commentId: string; text: string }> = [];
    for (const r of body.replies as Array<{ commentId?: unknown; text?: unknown }>) {
      if (typeof r.commentId !== 'string' || typeof r.text !== 'string') {
        return c.json({ error: 'each reply must have commentId and text strings' }, 400);
      }
      replies.push({ commentId: r.commentId, text: r.text });
    }

    // Refuse partial replies — every question must have one.
    const expected = new Set(pending.questions.map((q) => q.commentId));
    for (const r of replies) {
      if (!expected.has(r.commentId)) {
        return c.json({ error: `unknown commentId: ${r.commentId}` }, 400);
      }
    }
    if (replies.length !== pending.questions.length) {
      return c.json(
        { error: `expected ${pending.questions.length} replies, got ${replies.length}` },
        400,
      );
    }

    // Resolve waiter FIRST so the agent unblocks even if cleanup throws.
    const ok = reviewSessions.resolveReplies(sessionId, askId, replies);
    if (!ok) {
      return c.json({ error: 'failed to resolve replies' }, 409);
    }

    // Best-effort marker removal grouped by file.
    const byFile = new Map<string, string[]>();
    for (const q of pending.questions) {
      const list = byFile.get(q.filePath) ?? [];
      list.push(q.commentId);
      byFile.set(q.filePath, list);
    }
    for (const [filePath, ids] of byFile) {
      try {
        let content = await readFileText(filePath);
        for (const id of ids) content = removeComment(content, id);
        await writeFileText(filePath, content);
        notifyFileChanged(filePath);
      } catch (err) {
        console.warn(`[review-session] reply marker cleanup failed for ${filePath}:`, err);
      }
    }

    return c.json({ ok: true });
  });

  app.get('/api/review-sessions/:id/asks', (c) => {
    const id = c.req.param('id');
    if (!reviewSessions.getSession(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const asks = reviewSessions.getPendingAsks(id).map((a) => ({
      askId: a.askId,
      commentIds: a.questions.map((q) => q.commentId),
    }));
    return c.json({ asks });
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

    // If a batch was queued while the agent was busy, deliver it now.
    reviewSessions.deliverQueuedBatchIfAny(id);

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
