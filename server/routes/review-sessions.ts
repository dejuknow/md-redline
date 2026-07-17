import { randomUUID } from 'crypto';
import type { Hono } from 'hono';
import { extname } from 'path';
import type { PendingAsk, ReviewSessionStore, SessionOrigin } from '../review-sessions';
import { appendReply, insertComment, parseComments, removeComment, removeReply, transformCommentMarkers } from '../../src/lib/comment-parser';

/**
 * Deliver inline replies to pending asks.
 *
 * When the user answers an agent question via the comment sidebar, addReply
 * stores the reply inside the marker on disk (and clears expectsReply), but
 * nothing resolves the in-memory ask waiter: the agent would keep blocking
 * and eventually be told "no reply" even though the answer is sitting in the
 * file. This helper closes that gap by reading the markers back and resolving
 * asks whose questions now carry replies.
 *
 * Two call sites with different strictness:
 * - file-save hook (`requireComplete: true`): resolve only asks where EVERY
 *   question has a reply. The user may still be answering the rest; a partial
 *   eager resolve would cut them off mid-batch.
 * - /agent-done (`requireComplete: false`): the user explicitly finished, so
 *   deliver whatever replies exist. Questions without replies surface to the
 *   agent as unanswered ("N of M").
 *
 * Best-effort by design: a file that fails to read or parse skips its ask
 * (the ask then falls through to the normal done/abort paths).
 *
 * Returns one entry per resolved ask. `unanswered` lists the questions that
 * had no reply at delivery time (only possible with requireComplete: false):
 * their markers still carry expectsReply:true on disk and bypass the
 * onAsksClosedOnDone cleanup (resolveReplies already removed the ask), so
 * the caller is responsible for clearing those flags.
 */
export interface DeliveredAsk {
  askId: string;
  sessionId: string;
  unanswered: PendingAsk['questions'];
}

export async function deliverInlineAskReplies(opts: {
  reviewSessions: ReviewSessionStore;
  readFileText: (resolvedPath: string) => Promise<string>;
  /** Limit to one session's asks (the /agent-done path). */
  sessionId?: string;
  /** Limit to asks with at least one question in this file (the save path). */
  filePath?: string;
  /** Pre-read contents, keyed by resolved path. Avoids re-reading a file the caller just wrote. */
  knownContent?: ReadonlyMap<string, string>;
  requireComplete: boolean;
}): Promise<DeliveredAsk[]> {
  const { reviewSessions, readFileText, sessionId, filePath, knownContent, requireComplete } = opts;
  const asks: PendingAsk[] = sessionId
    ? reviewSessions.getPendingAsks(sessionId)
    : reviewSessions.listPendingAsks();
  const candidates = filePath
    ? asks.filter((a) => a.questions.some((q) => q.filePath === filePath))
    : asks;
  if (candidates.length === 0) return [];

  // Parse each file at most once across all candidate asks. `null` marks a
  // file that failed to read/parse so we don't retry it per question.
  const parsedByFile = new Map<string, ReturnType<typeof parseComments>['comments'] | null>();
  const delivered: DeliveredAsk[] = [];
  for (const ask of candidates) {
    const replies: Array<{ commentId: string; text: string }> = [];
    const unanswered: PendingAsk['questions'] = [];
    let readFailed = false;
    for (const q of ask.questions) {
      let comments = parsedByFile.get(q.filePath);
      if (comments === undefined) {
        try {
          const content = knownContent?.get(q.filePath) ?? (await readFileText(q.filePath));
          comments = parseComments(content).comments;
        } catch {
          comments = null;
        }
        parsedByFile.set(q.filePath, comments);
      }
      if (comments === null) {
        readFailed = true;
        break;
      }
      const marker = comments.find((c) => c.id === q.commentId);
      const replyTexts = (marker?.replies ?? [])
        .map((r) => r.text)
        .filter((t) => t.trim().length > 0);
      if (replyTexts.length > 0) {
        replies.push({ commentId: q.commentId, text: replyTexts.join('\n\n') });
      } else {
        unanswered.push(q);
      }
    }
    if (readFailed || replies.length === 0) continue;
    if (requireComplete && unanswered.length > 0) continue;
    if (reviewSessions.resolveReplies(ask.sessionId, ask.askId, replies)) {
      console.log(
        `[review-session] delivered ${replies.length}/${ask.questions.length} inline reply(ies) for ask ${ask.askId} (session ${ask.sessionId})`,
      );
      delivered.push({ askId: ask.askId, sessionId: ask.sessionId, unanswered });
    }
  }
  return delivered;
}

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
  /**
   * Atomically read-modify-write a file under the same per-file lock the
   * user-edit endpoint uses. Used by the agent-comments route so a
   * concurrent user edit can't be silently overwritten between read and
   * write. `transform` may return `null` to skip the write (the caller
   * uses this when its anchor-resolution step fails and it wants to
   * abort without persisting partial markers).
   */
  transformFile: (
    resolvedPath: string,
    transform: (current: string) => string | null,
  ) => Promise<{ original: string; updated: string | null }>;
  notifyFileChanged: (resolvedPath: string) => void;
}

/**
 * Hard caps on agent-controlled string fields, mirrored from
 * server/mcp-stdio/validate.ts. The MCP client enforces them first, but the
 * HTTP endpoint is reachable by any local process (the dev simulators prove
 * the path), so the caps must hold at this layer too — otherwise a buggy or
 * adversarial caller could persist megabyte-scale strings into the user's
 * markdown and freeze the renderer.
 */
const MAX_ANCHOR_LEN = 8 * 1024;
const MAX_TEXT_LEN = 64 * 1024;
const MAX_CONTEXT_LEN = 8 * 1024;

function fieldTooLong(field: string, value: string, max: number): string | null {
  return value.length > max
    ? `${field} exceeds maximum length of ${max} chars (got ${value.length})`
    : null;
}

export function registerReviewSessionRoutes(
  app: Hono,
  reviewSessions: ReviewSessionStore,
  deps: ReviewSessionRoutesDeps,
): void {
  const {
    resolveAndValidate,
    readFileText,
    transformFile,
    notifyFileChanged,
  } = deps;

  /**
   * Clear the on-disk `expectsReply` flag on the given questions' markers,
   * preserving the markers themselves (Done/Finish semantics: the question
   * stays in the file as a record of "asked, no answer", but must stop
   * reading as pending). Best-effort per file; failures are logged.
   */
  async function clearExpectsReplyFlags(
    questions: ReadonlyArray<{ filePath: string; commentId: string }>,
  ): Promise<void> {
    const byFile = new Map<string, Set<string>>();
    for (const q of questions) {
      const ids = byFile.get(q.filePath) ?? new Set<string>();
      ids.add(q.commentId);
      byFile.set(q.filePath, ids);
    }
    for (const [filePath, ids] of byFile) {
      try {
        const { original, updated } = await transformFile(filePath, (current) =>
          transformCommentMarkers(current, (cm) => {
            if (!cm?.id || !ids.has(cm.id)) return { type: 'keep' };
            if (!cm.expectsReply) return { type: 'keep' };
            const cleared = { ...cm };
            delete cleared.expectsReply;
            return { type: 'replace', comment: cleared };
          }),
        );
        if (updated !== null && updated !== original) notifyFileChanged(filePath);
      } catch (err) {
        console.warn(`[review-session] expectsReply-cleanup failed for ${filePath}:`, err);
      }
    }
  }
  app.post('/api/review-sessions', async (c) => {
    let body: { filePaths?: unknown; enableResolve?: unknown; origin?: unknown; clientId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { filePaths, enableResolve } = body;
    // origin is optional (defaults to 'user'), but if present must be exactly
    // 'user' or 'agent' — silently coercing unknown values like 'Agent' or 1
    // to 'user' was a source of confusion: an mdr_wait against the resulting
    // session would 409 with no obvious cause.
    let origin: SessionOrigin = 'user';
    if (body.origin !== undefined) {
      if (body.origin === 'user' || body.origin === 'agent') {
        origin = body.origin;
      } else {
        return c.json({ error: "origin must be 'user' or 'agent'" }, 400);
      }
    }
    // clientId is an optional opaque caller identity (each MCP server
    // process sends its own) that scopes dedupe so two distinct agents on
    // the same files get distinct sessions.
    let clientId: string | undefined;
    if (body.clientId !== undefined) {
      if (typeof body.clientId !== 'string' || body.clientId.length === 0 || body.clientId.length > 256) {
        return c.json({ error: 'clientId must be a non-empty string of at most 256 chars' }, 400);
      }
      clientId = body.clientId;
    }
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

    // Deduplicate within the same origin: if a recent open session for the
    // same files already exists, return it instead of creating a new one.
    // This prevents double browser tabs when the tool is called twice for
    // the same files (e.g. an agent batching its review work into multiple
    // successive tool calls).
    //
    // Cross-origin dedupe is NOT allowed: agent-origin and user-origin
    // sessions have divergent terminal-state contracts (setSessionDone vs
    // finish/abort), and attaching an agent to a user-origin session would
    // deadlock the agent's mdr_wait when the user clicks Finish/Cancel.
    const existing = reviewSessions.findOpenSession(resolved, origin, clientId);
    if (existing) {
      console.log(
        `[review-session] reusing ${existing.id} for ${resolved.length} file(s): ${resolved.join(', ')}`,
      );
      return c.json({
        sessionId: existing.id,
        url: `/?review=${encodeURIComponent(existing.id)}`,
        created: false,
        origin: existing.origin,
      });
    }

    const session = reviewSessions.createSession({
      filePaths: resolved,
      enableResolve: enableResolve === true,
      origin,
      clientId,
    });

    console.log(
      `[review-session] created ${session.id} for ${resolved.length} file(s): ${resolved.join(', ')}`,
    );

    return c.json(
      {
        sessionId: session.id,
        url: `/?review=${encodeURIComponent(session.id)}`,
        created: true,
        origin: session.origin,
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
    let body: { prompt?: unknown; commentIds?: unknown; commentCounts?: unknown };
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
    const sessionForCounts = reviewSessions.getSession(id);
    // commentCounts is optional; required only for the queue-rebuild path
    // to render accurate per-file counts in multi-file mode. Keys are
    // validated against session.filePaths so an external caller can't
    // smuggle arbitrary strings into the rebuilt prompt the agent reads.
    const commentCountsByPath = new Map<string, number>();
    if (body.commentCounts && typeof body.commentCounts === 'object') {
      const allowedPaths = new Set(sessionForCounts?.filePaths ?? []);
      for (const [path, count] of Object.entries(body.commentCounts as Record<string, unknown>)) {
        if (!allowedPaths.has(path)) continue;
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          commentCountsByPath.set(path, count);
        }
      }
    }
    const ok = reviewSessions.sendBatch(id, body.prompt, body.commentIds as string[]);
    if (!ok) {
      // Direct delivery wasn't possible: the agent is busy with the previous
      // batch (waitingForAgent), or no /wait poll is parked right now — the
      // MCP client re-polls with ?timeout=90, so between polls there is
      // nobody to deliver to. Queue the batch; the next waitForSession call
      // delivers it. We store IDs + counts (not a prebuilt prompt) so
      // back-to-back queues merge cleanly and the prompt is rebuilt at
      // delivery time (avoids duplicated system-instruction preambles).
      const queued = reviewSessions.queueBatch(
        id,
        body.commentIds as string[],
        commentCountsByPath,
      );
      if (!queued) {
        return c.json({ error: 'Session is not open' }, 409);
      }
      console.log(`[review-session] batch queued for ${id} (${(body.commentIds as string[]).length} comments)`);
      return c.json({ ok: true, queued: true });
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
    // Finish is the user-origin "I'm finished" signal, so pending asks get
    // the same treatment as /agent-done: deliver any inline replies first,
    // then close whatever is still unanswered as done_without_reply with the
    // markers preserved on disk (flags cleared). Without this, finish()'s
    // defensive abortAsks would mis-report the asks as session_cancelled and
    // onSessionAborted would strip the markers, erasing the question record.
    if (reviewSessions.getPendingAsks(id).length > 0) {
      try {
        const delivered = await deliverInlineAskReplies({
          reviewSessions,
          readFileText,
          sessionId: id,
          requireComplete: false,
        });
        await clearExpectsReplyFlags(delivered.flatMap((d) => d.unanswered));
        const closed = reviewSessions.abortAsks(id, 'done_without_reply');
        await clearExpectsReplyFlags(closed.flatMap((a) => a.questions));
      } catch (err) {
        console.warn(`[review-session] inline-reply delivery on finish failed for ${id}:`, err);
      }
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

    let body: {
      mode?: unknown;
      comments?: unknown;
      questions?: unknown;
      replies?: unknown;
      expectsReply?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // The mdr_ask and mdr_review tools share this endpoint but have different
    // contracts: ask blocks for a user reply via addAsk, review is always
    // fire-and-forget. The mode is driven by an explicit `mode` field
    // ('ask' | 'review') sent by the MCP client (see server/mcp-stdio/client.ts).
    //
    // For callers that omit `mode`, fall back to a shape-based heuristic:
    // a `questions` field without an accompanying `comments` array implies
    // ask mode; a `comments` field without `questions` implies review.
    // The ambiguous case (both arrays present, no explicit mode) is
    // rejected — silently collapsing it to review would discard the
    // caller's questions intent.
    const explicitMode =
      typeof body.mode === 'string' && (body.mode === 'ask' || body.mode === 'review')
        ? (body.mode as 'ask' | 'review')
        : null;
    // length > 0 — an empty `questions: []` on an explicit review-mode call
    // would otherwise flip the inference path to ask mode silently.
    const hasQuestionsArray = Array.isArray(body.questions) && body.questions.length > 0;
    const hasCommentsArray = Array.isArray(body.comments) && body.comments.length > 0;
    if (explicitMode === null && hasQuestionsArray && hasCommentsArray) {
      return c.json(
        {
          error:
            'cannot infer mode: both `questions` and `comments` arrays present. ' +
            "Pass `mode: 'ask'` or `mode: 'review'` explicitly.",
        },
        400,
      );
    }
    // mode:'ask' explicitly with `comments:` arr silently dropped the
    // `questions:` payload pre-fix because rawComments preferred body.comments.
    // Force callers to use the canonical shape so a typo can't hide an
    // entire question list.
    if (explicitMode === 'ask' && hasCommentsArray) {
      return c.json(
        {
          error:
            "mode:'ask' must use the `questions:` array, not `comments:`. " +
            'For fire-and-forget review-mode posts use mode:\'review\'.',
        },
        400,
      );
    }
    // Symmetric guard: mode:'review' + questions:[] would silently coerce
    // questions into comments via `rawComments = body.comments ?? body.questions`.
    // Reject so a typoed mode doesn't hide the wrong intent.
    if (explicitMode === 'review' && hasQuestionsArray) {
      return c.json(
        {
          error:
            "mode:'review' must use the `comments:` array, not `questions:`. " +
            "Use mode:'ask' for question-bearing posts.",
        },
        400,
      );
    }
    const isAskRequest =
      explicitMode === 'ask' ||
      (explicitMode === null && hasQuestionsArray && !hasCommentsArray);
    // If `mode` was omitted AND neither questions[] nor comments[] is
    // present, the caller's intent is ambiguous (replies-only? error?).
    // Treat as review-mode replies-only ONLY if the caller is explicit
    // (mode:'review'); otherwise require explicit mode so we don't silently
    // accept under-specified payloads.
    const hasRepliesArray = Array.isArray(body.replies);
    if (explicitMode === null && !hasQuestionsArray && !hasCommentsArray && hasRepliesArray) {
      return c.json(
        {
          error:
            "replies-only request without explicit mode is ambiguous. " +
            "Pass mode:'review' to confirm fire-and-forget reply intent.",
        },
        400,
      );
    }

    // Ask-mode is allowed on BOTH origins. User-origin sessions are in fact
    // the flagship use case: an agent addressing the user's review comments
    // (mdr_request_review handoff) hits an ambiguity and asks a clarifying
    // question mid-task. The question surfaces as a normal comment card in
    // the sidebar; the user's inline reply resolves the ask via the
    // file-save sweep (deliverInlineAskReplies), and /finish delivers any
    // remaining inline replies before closing leftovers as
    // done_without_reply. No dedicated Reply/Release affordance is needed.

    // Reject the contradictory combination of "ask request" + expectsReply:false,
    // whether the ask mode is explicit OR inferred from shape. mdr_ask's contract
    // is "block until the user replies"; opting out of the reply turns it into a
    // fire-and-forget review, which is what mdr_review is for. The combination
    // was previously silently downgraded; surface it as an explicit error so
    // callers don't get a confusing no-op.
    if (isAskRequest && body.expectsReply === false) {
      return c.json(
        {
          error:
            "ask-mode request with expectsReply:false is contradictory. " +
            "Use mode:'review' for fire-and-forget posts.",
        },
        400,
      );
    }
    // Symmetric check: review-mode (either explicit or inferred from shape)
    // paired with expectsReply:true was previously silently downgraded to
    // fire-and-forget — the caller asked for a blocking reply on the wrong
    // tool. Surface as 400 so caller drift doesn't fail open.
    const isReviewRequest = explicitMode === 'review' || (explicitMode === null && hasCommentsArray);
    if (isReviewRequest && body.expectsReply === true) {
      return c.json(
        {
          error:
            "review-mode request with expectsReply:true is contradictory. " +
            "Use mode:'ask' (with `questions:`) for blocking reply semantics.",
        },
        400,
      );
    }

    // Accept `comments` as canonical; `questions` is a backward-compat alias for mdr_ask.
    const rawComments = body.comments ?? body.questions;
    const rawReplies = body.replies;
    const expectsReply = isAskRequest && body.expectsReply !== false;

    const commentsArr = Array.isArray(rawComments) ? rawComments : [];
    const repliesArr = Array.isArray(rawReplies) ? rawReplies : [];

    if (commentsArr.length === 0 && repliesArr.length === 0) {
      return c.json({ error: 'at least one of comments or replies must be a non-empty array' }, 400);
    }

    // Validate and resolve each comment (new top-level marker).
    type ResolvedComment = {
      originalIndex: number;
      commentId: string;
      filePath: string;
      anchor: string;
      text: string;
      author: string;
      contextBefore?: string;
      contextAfter?: string;
    };
    const resolvedComments: ResolvedComment[] = [];
    for (let i = 0; i < commentsArr.length; i++) {
      const q = commentsArr[i] as {
        filePath?: unknown;
        anchor?: unknown;
        text?: unknown;
        author?: unknown;
        contextBefore?: unknown;
        contextAfter?: unknown;
      };
      if (typeof q.filePath !== 'string' || typeof q.anchor !== 'string' || typeof q.text !== 'string') {
        return c.json({ error: `comment ${i}: filePath, anchor, text must be strings` }, 400);
      }
      const oversize =
        fieldTooLong(`comment ${i}: anchor`, q.anchor, MAX_ANCHOR_LEN) ||
        fieldTooLong(`comment ${i}: text`, q.text, MAX_TEXT_LEN) ||
        (typeof q.contextBefore === 'string' &&
          fieldTooLong(`comment ${i}: contextBefore`, q.contextBefore, MAX_CONTEXT_LEN)) ||
        (typeof q.contextAfter === 'string' &&
          fieldTooLong(`comment ${i}: contextAfter`, q.contextAfter, MAX_CONTEXT_LEN));
      if (oversize) {
        return c.json({ error: oversize }, 400);
      }
      let canonicalPath: string;
      try {
        canonicalPath = await resolveAndValidate(q.filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid path';
        return c.json({ error: `comment ${i}: ${msg}` }, 400);
      }
      if (!session.filePaths.includes(canonicalPath)) {
        return c.json({ error: `comment ${i}: filePath not part of this session` }, 400);
      }
      resolvedComments.push({
        originalIndex: i,
        commentId: `cmt_${randomUUID()}`,
        filePath: canonicalPath,
        anchor: q.anchor,
        text: q.text,
        author: typeof q.author === 'string' && q.author.trim().length > 0 ? q.author.trim() : 'Agent',
        contextBefore: typeof q.contextBefore === 'string' ? q.contextBefore : undefined,
        contextAfter: typeof q.contextAfter === 'string' ? q.contextAfter : undefined,
      });
    }

    // Validate and resolve each reply (append to an existing marker).
    type ResolvedReply = {
      originalIndex: number;
      filePath: string;
      commentId: string;
      text: string;
      author: string;
    };
    const resolvedReplies: ResolvedReply[] = [];
    for (let i = 0; i < repliesArr.length; i++) {
      const r = repliesArr[i] as { filePath?: unknown; commentId?: unknown; text?: unknown; author?: unknown };
      if (typeof r.filePath !== 'string' || typeof r.commentId !== 'string' || typeof r.text !== 'string') {
        return c.json({ error: `reply ${i}: filePath, commentId, text must be strings` }, 400);
      }
      const oversizeReply = fieldTooLong(`reply ${i}: text`, r.text, MAX_TEXT_LEN);
      if (oversizeReply) {
        return c.json({ error: oversizeReply }, 400);
      }
      let canonicalPath: string;
      try {
        canonicalPath = await resolveAndValidate(r.filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid path';
        return c.json({ error: `reply ${i}: ${msg}` }, 400);
      }
      if (!session.filePaths.includes(canonicalPath)) {
        return c.json({ error: `reply ${i}: filePath not part of this session` }, 400);
      }
      resolvedReplies.push({
        originalIndex: i,
        filePath: canonicalPath,
        commentId: r.commentId,
        text: r.text,
        author: typeof r.author === 'string' && r.author.trim().length > 0 ? r.author.trim() : 'Agent',
      });
    }

    // For ask-mode, verify no prior ask is still pending BEFORE writing any
    // markers to disk. Otherwise a 409 from addAsk would leave orphaned
    // `agentInitiated: true` markers in the file that the agent may not
    // retry-clean up.
    if (expectsReply) {
      if (resolvedComments.length === 0) {
        // Ask mode with no new comments would create a pendingAsk on an
        // empty question set — the waiter would never resolve via the
        // normal reply path (since there's nothing to reply to). Reject so
        // the agent gets a clear 400 instead of a hung tool call.
        return c.json(
          { error: 'mdr_ask requires at least one comment (question) in the request' },
          400,
        );
      }
      const pendingAsks = reviewSessions.getPendingAsks(id);
      if (pendingAsks.length > 0) {
        return c.json(
          { error: 'a previous mdr_ask is still pending; receive its reply first' },
          409,
        );
      }
    }

    // Collect all unique file paths that need to be read and written.
    const allFilePaths = new Set<string>([
      ...resolvedComments.map((rc) => rc.filePath),
      ...resolvedReplies.map((r) => r.filePath),
    ]);

    // Per-file: enter the writeLock, read current content, apply markers,
    // detect anchor failures, write atomically. Doing read-and-write under
    // the same lock prevents a concurrent user edit from being silently
    // overwritten between the agent's read and write.
    //
    // Failures (missing anchors, write errors) trigger a rollback of any
    // already-written files in this batch. The rollback uses transformFile
    // to re-acquire the lock and remove ONLY the comment IDs this batch
    // inserted (via removeComment). A blind write-back of the pre-batch
    // snapshot would race against concurrent user edits landed after the
    // batch released the lock.
    type CommittedWrite = {
      filePath: string;
      insertedCommentIds: string[];
      appendedReplies: Array<{ commentId: string; replyId: string }>;
      /**
       * Markers whose `expectsReply:true` flag was cleared by an appendReply
       * call in this batch. On rollback, after removing our reply we must
       * restore the flag — otherwise the pending question silently disappears
       * from the ask UI (selectAgentAsks filters on expectsReply===true).
       */
      restoredExpectsReply: string[];
    };
    const completedWrites: CommittedWrite[] = [];
    const failedComments: number[] = [];
    const failedReplies: number[] = [];

    const rollbackCompletedWrites = async () => {
      for (const w of completedWrites) {
        try {
          const { original, updated } = await transformFile(w.filePath, (current) => {
            // Identify markers with replies BEFORE removal — a user who replied
            // via the sidebar between our write and the rollback would lose
            // their text if we blindly removed the marker. Preserve any
            // marker that has at least one reply, removing only orphan inserts.
            const parsed = parseComments(current);
            const idHasReplies = new Map<string, boolean>();
            for (const c of parsed.comments) {
              idHasReplies.set(c.id, !!c.replies && c.replies.length > 0);
            }
            let next = current;
            for (const cid of w.insertedCommentIds) {
              if (idHasReplies.get(cid)) continue; // preserve — user replied
              next = removeComment(next, cid);
            }
            // For appended replies, removeReply by replyId is safe — it only
            // removes the specific reply we added, leaving any other replies
            // (including user ones) intact.
            for (const r of w.appendedReplies) next = removeReply(next, r.commentId, r.replyId);
            // Restore expectsReply on any marker we cleared via appendReply.
            // appendReply (in comment-parser) clears the flag whenever it
            // lands; if the rollback removed our reply, the question is
            // pending again and the UI must surface it.
            if (w.restoredExpectsReply.length > 0) {
              const toRestore = new Set(w.restoredExpectsReply);
              next = transformCommentMarkers(next, (c) => {
                if (!c?.id || !toRestore.has(c.id)) return { type: 'keep' };
                if (c.expectsReply) return { type: 'keep' };
                return { type: 'replace', comment: { ...c, expectsReply: true } };
              });
            }
            return next;
          });
          if (updated !== null && updated !== original) {
            notifyFileChanged(w.filePath);
          }
        } catch (rollbackErr) {
          console.error(
            `[review-session] rollback failed for ${w.filePath}:`,
            rollbackErr,
          );
        }
      }
    };

    try {
      for (const filePath of allFilePaths) {
        const fileComments = resolvedComments.filter((rc) => rc.filePath === filePath);
        const fileReplies = resolvedReplies.filter((r) => r.filePath === filePath);
        const localFailedComments: number[] = [];
        const localFailedReplies: number[] = [];
        const appendedReplies: Array<{ commentId: string; replyId: string }> = [];
        // Track which markers had expectsReply:true pre-batch so rollback can
        // restore the flag if our reply lands and is later undone.
        const restoredExpectsReply: string[] = [];

        const { original, updated } = await transformFile(filePath, (current) => {
          // Snapshot expectsReply:true status BEFORE we apply any changes.
          const preBatch = parseComments(current);
          const preExpectsReply = new Map<string, boolean>();
          for (const c of preBatch.comments) {
            preExpectsReply.set(c.id, !!c.expectsReply);
          }
          let next = current;
          for (const q of fileComments) {
            const before = next;
            next = insertComment(
              next,
              q.anchor,
              q.text,
              q.author,
              q.contextBefore,
              q.contextAfter,
              undefined,
              q.commentId,
              // expectsReply distinguishes mdr_ask (true) from mdr_review
              // (false). The UI uses this to gate the "agent has a question"
              // toast and the "Jump to next agent question" palette entry.
              { agentInitiated: true, expectsReply: expectsReply, sessionId: id },
            );
            if (next === before) {
              // insertComment returns input unchanged when anchor is not found.
              localFailedComments.push(q.originalIndex);
            }
          }
          for (const r of fileReplies) {
            const before = next;
            const replyId = `rep_${randomUUID()}`;
            next = appendReply(next, r.commentId, {
              id: replyId,
              text: r.text,
              author: r.author,
              timestamp: new Date().toISOString(),
            });
            if (next === before) {
              // appendReply returns input unchanged when commentId is not found.
              localFailedReplies.push(r.originalIndex);
            } else {
              appendedReplies.push({ commentId: r.commentId, replyId });
              // appendReply clears expectsReply on the target marker. If
              // that flag was true pre-batch, record it for rollback restoration.
              if (preExpectsReply.get(r.commentId)) {
                restoredExpectsReply.push(r.commentId);
              }
            }
          }
          // If any anchor failed for this file, skip the write — the caller
          // will roll back any prior files and return 400. This keeps file
          // contents intact across failed anchor resolution.
          if (localFailedComments.length > 0 || localFailedReplies.length > 0) {
            return null;
          }
          return next;
        });

        failedComments.push(...localFailedComments);
        failedReplies.push(...localFailedReplies);

        if (localFailedComments.length > 0 || localFailedReplies.length > 0) {
          // Anchor failure: rollback prior successes and abort the batch.
          // We DON'T continue iterating — surfacing all failures across
          // remaining files would either require another full pass (under
          // lock, no writes) or risk further writes that the final 400
          // would need to roll back too. The current contract is "report
          // the first file that fails"; the agent retries with anchors
          // re-derived against the current file contents.
          await rollbackCompletedWrites();
          return c.json(
            {
              error: 'one or more anchors or reply targets could not be located',
              failedComments,
              failedReplies,
            },
            400,
          );
        }

        if (updated !== null && updated !== original) {
          completedWrites.push({
            filePath,
            insertedCommentIds: fileComments.map((c) => c.commentId),
            appendedReplies,
            restoredExpectsReply,
          });
          notifyFileChanged(filePath);
        }
      }
    } catch (err) {
      await rollbackCompletedWrites();
      const msg = err instanceof Error ? err.message : 'agent batch write failed';
      return c.json(
        { error: `agent batch write failed and was rolled back: ${msg}` },
        500,
      );
    }

    // Bump the agent comment counter so gcSilentAgentSessions won't abort
    // this session for being silent — the agent has clearly started working.
    // Reply-only posts still count as agent activity for spinner UX, but
    // don't bump the comment count (so the gc threshold logic stays accurate).
    if (resolvedComments.length > 0) {
      reviewSessions.recordAgentComments(id, resolvedComments.length);
    } else if (resolvedReplies.length > 0) {
      reviewSessions.recordAgentComments(id, 0);
    }

    // If any of these replies target a pending mdr_ask's commentId, resolve
    // that ask so the agent's waitForAsk unblocks AND apply the same on-disk
    // cleanup the /asks/:askId/reply route uses: remove answered markers,
    // clear expectsReply on unanswered ones. Without this mirror, the in-
    // memory ask resolves but the markers stay with expectsReply=true,
    // surfacing in the agent-asks UI with no live resolution channel.
    if (resolvedReplies.length > 0) {
      const pendingAsks = reviewSessions.getPendingAsks(id);
      type AskCleanup = { filePath: string; toRemove: string[]; toCloseFlag: string[] };
      const cleanupByFile = new Map<string, AskCleanup>();
      for (const ask of pendingAsks) {
        const matchingReplies: Array<{ commentId: string; text: string }> = [];
        for (const q of ask.questions) {
          const r = resolvedReplies.find((rr) => rr.commentId === q.commentId);
          if (r) matchingReplies.push({ commentId: q.commentId, text: r.text });
        }
        if (matchingReplies.length === 0) continue;
        const repliedSet = new Set(matchingReplies.map((m) => m.commentId));
        reviewSessions.resolveReplies(id, ask.askId, matchingReplies);
        for (const q of ask.questions) {
          const group = cleanupByFile.get(q.filePath) ?? {
            filePath: q.filePath,
            toRemove: [],
            toCloseFlag: [],
          };
          if (repliedSet.has(q.commentId)) group.toRemove.push(q.commentId);
          else group.toCloseFlag.push(q.commentId);
          cleanupByFile.set(q.filePath, group);
        }
      }
      // Apply marker cleanup per file. Best-effort: failures are logged but
      // don't fail the request (the agent already got its 201 path forward,
      // and the markers are file-state, not transactional with the response).
      for (const [filePath, group] of cleanupByFile) {
        try {
          const { original, updated } = await transformFile(filePath, (current) => {
            let next = current;
            for (const cid of group.toRemove) next = removeComment(next, cid);
            if (group.toCloseFlag.length > 0) {
              const closeSet = new Set(group.toCloseFlag);
              next = transformCommentMarkers(next, (c) => {
                if (!c?.id || !closeSet.has(c.id)) return { type: 'keep' };
                if (!c.expectsReply) return { type: 'keep' };
                const cleared = { ...c };
                delete cleared.expectsReply;
                return { type: 'replace', comment: cleared };
              });
            }
            return next;
          });
          if (updated !== null && updated !== original) notifyFileChanged(filePath);
        } catch (err) {
          console.warn(`[review-session] mdr_review ask-cleanup failed for ${filePath}:`, err);
        }
      }
    }

    // When expectsReply=false (fire-and-forget mode), skip addAsk entirely.
    if (!expectsReply) {
      return c.json(
        {
          commentIds: resolvedComments.map((q) => q.commentId),
          commentsWritten: resolvedComments.length,
          repliesWritten: resolvedReplies.length,
        },
        201,
      );
    }

    // expectsReply=true (default): create a pendingAsk for the new comments.
    // Replies are not included in the ask payload — they're fire-and-forget by design
    // (asks track only new comments awaiting a human reply, not append-only replies).
    //
    // If addAsk fails (concurrent ask landed between our pre-check and now,
    // or addAsk's agentCommentCount>0 guard fires), roll back the just-written
    // markers so they don't sit orphaned in the file. The TOCTOU race here is
    // theoretical for single-user dev tools but cheap to defend. Also decrement
    // agentCommentCount: rollback removes the markers from disk, so the counter
    // must reflect that, or the next addAsk on this session would pass the
    // "agent has posted" guard against a session that no longer has markers.
    let askId: string;
    try {
      askId = reviewSessions.addAsk(
        id,
        resolvedComments.map((q) => ({
          commentId: q.commentId,
          filePath: q.filePath,
          anchor: q.anchor,
          text: q.text,
          contextBefore: q.contextBefore,
          contextAfter: q.contextAfter,
        })),
      ).askId;
    } catch (err) {
      await rollbackCompletedWrites();
      if (resolvedComments.length > 0) {
        reviewSessions.unrecordAgentComments(id, resolvedComments.length);
      }
      return c.json({ error: err instanceof Error ? err.message : 'addAsk failed' }, 409);
    }
    return c.json(
      {
        askId,
        commentsWritten: resolvedComments.length,
        repliesWritten: resolvedReplies.length,
      },
      201,
    );
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

    // Validate that every supplied reply references a comment that belongs to this ask.
    const expected = new Set(pending.questions.map((q) => q.commentId));
    for (const r of replies) {
      if (!expected.has(r.commentId)) {
        return c.json({ error: `unknown commentId: ${r.commentId}` }, 400);
      }
    }
    // Partial replies are allowed — comments without a reply are implicit "no reply".

    // Resolve waiter FIRST so the agent unblocks even if cleanup throws.
    const ok = reviewSessions.resolveReplies(sessionId, askId, replies);
    if (!ok) {
      return c.json({ error: 'failed to resolve replies' }, 409);
    }

    // Best-effort marker mutation grouped by file. Use transformFile so the
    // read+modify+write happens under the same per-file lock as user edits
    // and the main agent-comments path — otherwise a concurrent user edit
    // could be silently overwritten by the cleanup.
    //
    // Partial-reply semantics:
    //   - Markers for questions that DID receive a reply → remove (the answer
    //     is now persisted via resolveReplies' in-memory payload, and the
    //     marker is no longer needed for the ask UI).
    //   - Markers for questions that did NOT receive a reply → preserve, but
    //     clear `expectsReply` so the marker reflects "closed without reply"
    //     rather than "still pending." Same semantic as setSessionDone's
    //     done_without_reply path.
    const repliedIds = new Set(replies.map((r) => r.commentId));
    type FileGroup = { filePath: string; toRemove: string[]; toCloseFlag: string[] };
    const byFile = new Map<string, FileGroup>();
    for (const q of pending.questions) {
      const group = byFile.get(q.filePath) ?? { filePath: q.filePath, toRemove: [], toCloseFlag: [] };
      if (repliedIds.has(q.commentId)) group.toRemove.push(q.commentId);
      else group.toCloseFlag.push(q.commentId);
      byFile.set(q.filePath, group);
    }
    for (const [filePath, group] of byFile) {
      try {
        const { original, updated } = await transformFile(filePath, (current) => {
          let next = current;
          for (const id of group.toRemove) next = removeComment(next, id);
          if (group.toCloseFlag.length > 0) {
            const closeSet = new Set(group.toCloseFlag);
            next = transformCommentMarkers(next, (c) => {
              if (!c?.id || !closeSet.has(c.id)) return { type: 'keep' };
              if (!c.expectsReply) return { type: 'keep' };
              const cleared = { ...c };
              delete cleared.expectsReply;
              return { type: 'replace', comment: cleared };
            });
          }
          return next;
        });
        if (updated !== null && updated !== original) {
          notifyFileChanged(filePath);
        }
      } catch (err) {
        console.warn(`[review-session] reply marker cleanup failed for ${filePath}:`, err);
      }
    }

    return c.json({ ok: true });
  });

  app.post('/api/review-sessions/:id/asks/:askId/release', async (c) => {
    const sessionId = c.req.param('id');
    const askId = c.req.param('askId');
    if (!reviewSessions.getSession(sessionId)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    // Snapshot the ask's questions BEFORE release — releaseAsk deletes the
    // pendingAsks entry, so we lose the commentId/filePath mapping needed
    // to clean up the on-disk markers.
    const ask = reviewSessions.getPendingAsks(sessionId).find((a) => a.askId === askId);
    const ok = reviewSessions.releaseAsk(sessionId, askId);
    if (!ok) {
      return c.json({ error: 'Ask not found' }, 404);
    }
    console.log(`[review-session] ask ${askId} released by user (session ${sessionId})`);

    // Clear expectsReply on the now-released markers so they don't keep
    // surfacing in the agent-asks UI with no live resolution channel.
    // Markers are PRESERVED (a record that the question was asked) — only
    // the pending flag is cleared. Mirrors setOnAsksClosedOnDone's behaviour
    // for the user-Done path. Best-effort: failures are logged but don't
    // fail the request.
    if (ask && ask.questions.length > 0) {
      const byFile = new Map<string, string[]>();
      for (const q of ask.questions) {
        const ids = byFile.get(q.filePath) ?? [];
        ids.push(q.commentId);
        byFile.set(q.filePath, ids);
      }
      for (const [filePath, commentIds] of byFile) {
        try {
          const targetIds = new Set(commentIds);
          const { original, updated } = await transformFile(filePath, (current) => {
            return transformCommentMarkers(current, (cm) => {
              if (!cm?.id || !targetIds.has(cm.id)) return { type: 'keep' };
              if (!cm.expectsReply) return { type: 'keep' };
              const cleared = { ...cm };
              delete cleared.expectsReply;
              return { type: 'replace', comment: cleared };
            });
          });
          if (updated !== null && updated !== original) notifyFileChanged(filePath);
        } catch (err) {
          console.warn(`[review-session] release expectsReply-cleanup failed for ${filePath}:`, err);
        }
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
    // /wait is for the user-batch flow (request-review → sendBatch → finish).
    // Agent-origin sessions resolve via /agent-wait + doneResolver — calling
    // /wait against an agent session would park for the 30-minute heartbeat
    // timeout because setSessionDone never resolves the legacy ReviewResult
    // waiter. Mirror /agent-wait's 409.
    if (session.origin !== 'user') {
      return c.json(
        { error: '/wait only applies to user-origin sessions; use /agent-wait' },
        409,
      );
    }

    // Optional ?timeout=<seconds> lets polling clients (e.g. Codex, which
    // enforces a 120s hard timeout per tool call) avoid being killed. The
    // endpoint returns {status:'pending'} after the timeout so the client can
    // re-poll without losing the session.
    const timeoutParam = c.req.query('timeout');
    // Validate the parsed timeout: NaN (e.g. 'abc') or non-positive values
    // would have fallen into the unbounded-wait branch, leaving the caller
    // hanging until the heartbeat sweep. Reject 400 instead. `0` is also
    // not meaningful as a long-poll timeout.
    let timeoutMs = 0;
    if (timeoutParam !== undefined) {
      const parsedSec = parseInt(timeoutParam, 10);
      if (!Number.isFinite(parsedSec) || parsedSec <= 0) {
        return c.json({ error: 'timeout query parameter must be a positive integer (seconds)' }, 400);
      }
      timeoutMs = parsedSec * 1000;
    }

    // Bracket the await with parked-waiter accounting so sendBatch can tell
    // whether a live poll is listening (deliver directly) or not (queue for
    // the next poll). release() is once-only so the finally can't
    // double-decrement a count owned by a concurrent poll.
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        reviewSessions.endWaitPark(id);
      }
    };
    reviewSessions.beginWaitPark(id);
    try {
      // waitForSession's resolution handles queued-batch delivery internally
      // (it inspects s.queuedBatch and resolves the waiter with that batch
      // before installing a fresh waiter).
      //
      // waitForSession returns the session's existing waiter promise. If the
      // session is already resolved, the promise is already settled and
      // resolves immediately. If still open, this awaits until
      // batch/finish/abort/sweep.
      const waiterPromise = reviewSessions.waitForSession(id);

      // A poll whose client vanished must not count as parked — sendBatch
      // would deliver into the dead connection and the batch would be lost.
      // The request's abort signal un-parks it (best effort: if the runtime
      // never fires the signal, behavior degrades to the pre-fix status quo
      // for this narrow case).
      const ABORTED = Symbol('aborted');
      const PENDING = Symbol('pending');
      const signal: AbortSignal | undefined = c.req.raw.signal;
      const connectionAborted = new Promise<typeof ABORTED>((resolve) => {
        if (!signal) return; // never resolves; no abort support
        if (signal.aborted) resolve(ABORTED);
        else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
      });

      if (timeoutMs > 0) {
        const pending = new Promise<typeof PENDING>((resolve) => {
          const t = setTimeout(() => resolve(PENDING), timeoutMs);
          if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
        });
        const result = await Promise.race([waiterPromise, pending, connectionAborted]);
        if (result !== PENDING && result !== ABORTED) {
          return c.json(result);
        }
        // Un-park BEFORE the settled recheck: from this point a concurrent
        // Send batch queues instead of delivering. Then catch the opposite
        // interleave — a batch delivered to our waiter in the same tick the
        // timeout fired — by rechecking settledness; reporting it as
        // 'pending' would lose it (sendBatch already installed a fresh
        // waiter). The two synchronous statements leave no window between
        // them for a batch to fall through.
        release();
        const late = await Promise.race([waiterPromise, Promise.resolve(PENDING)]);
        if (late !== PENDING) {
          return c.json(late);
        }
        return c.json({ status: 'pending' });
      }

      const result = await Promise.race([waiterPromise, connectionAborted]);
      if (result !== ABORTED) {
        return c.json(result);
      }
      // Connection died while parked; the finally un-parks so future batches
      // queue. The response body goes nowhere — 'pending' is as good as any.
      return c.json({ status: 'pending' });
    } finally {
      release();
    }
  });

  // POST /agent-done is the "user clicked Done in the agent-review banner"
  // signal. It is restricted to agent-origin sessions — user-origin sessions
  // close via /finish or /abort, which carry richer payloads (final prompt,
  // commentIds). Calling /agent-done on a user-origin session returns 409.
  app.post('/api/review-sessions/:id/agent-done', async (c) => {
    const id = c.req.param('id');
    const session = reviewSessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (session.origin !== 'agent') {
      return c.json(
        { error: '/agent-done only applies to agent-origin sessions; use /finish or /abort' },
        409,
      );
    }
    // Done is the user's "I'm finished" signal. Before closing pending asks
    // as done_without_reply, read the markers back from disk and deliver any
    // inline replies the user typed in the sidebar. Without this, answers
    // written into the markers would be reported to the agent as "the user
    // clicked Done without replying." Partial replies are delivered as-is
    // (the user explicitly finished; unanswered questions stay unanswered).
    try {
      const delivered = await deliverInlineAskReplies({
        reviewSessions,
        readFileText,
        sessionId: id,
        requireComplete: false,
      });
      // Unanswered questions in a partial delivery bypass the
      // onAsksClosedOnDone cleanup (resolveReplies already removed the ask
      // before setSessionDone runs), so clear their on-disk expectsReply
      // flags here. Answered markers were already cleared by addReply.
      await clearExpectsReplyFlags(delivered.flatMap((d) => d.unanswered));
    } catch (err) {
      console.warn(`[review-session] inline-reply delivery on agent-done failed for ${id}:`, err);
    }
    try {
      reviewSessions.setSessionDone(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'agent-done failed';
      return c.json({ error: msg }, 409);
    }
    console.log(`[review-session] agent-done for ${id}`);
    return c.json({ ok: true });
  });

  app.get('/api/review-sessions/:id/agent-wait', async (c) => {
    const id = c.req.param('id');
    // If the session has aged out of TERMINAL_RETENTION_MS but was previously
    // marked done, the agent's late mdr_wait poll should still see 'done'
    // rather than a noisy 404. We check this BEFORE the existence test so the
    // returned status reflects what actually happened, not the GC state.
    const session = reviewSessions.getSession(id);
    if (!session) {
      if (reviewSessions.wasSessionDone(id)) {
        // GC'd-but-known session. Use the remembered terminal reason so the
        // agent sees aborted/finished/etc accurately, not a blanket 'done'.
        const reason = reviewSessions.getTerminalReason(id);
        if (reason === null || reason === 'done') {
          return c.json({ status: 'done' });
        }
        return c.json({ status: 'aborted', reason });
      }
      return c.json({ error: 'Session not found' }, 404);
    }
    // /agent-wait is agent-only: user-origin sessions never resolve doneResolver
    // (they close via /finish or /abort, not /agent-done). Without this gate,
    // a misdirected mdr_wait would long-poll for the full 30-minute heartbeat
    // timeout before responding.
    if (session.origin !== 'agent') {
      return c.json(
        { error: '/agent-wait only applies to agent-origin sessions' },
        409,
      );
    }

    let doneWaiter: Promise<void>;
    try {
      doneWaiter = reviewSessions.waitForSessionDone(id);
    } catch {
      return c.json({ error: 'Session not found' }, 404);
    }

    const timeoutParam = c.req.query('timeout');
    // Validate the parsed timeout: NaN (e.g. 'abc') or non-positive values
    // would have fallen into the unbounded-wait branch, leaving the caller
    // hanging until the heartbeat sweep. Reject 400 instead. `0` is also
    // not meaningful as a long-poll timeout.
    let timeoutMs = 0;
    if (timeoutParam !== undefined) {
      const parsedSec = parseInt(timeoutParam, 10);
      if (!Number.isFinite(parsedSec) || parsedSec <= 0) {
        return c.json({ error: 'timeout query parameter must be a positive integer (seconds)' }, 400);
      }
      timeoutMs = parsedSec * 1000;
    }

    // Build the post-wait response. setSessionDone (user clicked Done) →
    // {status:'done'}. Any other terminal path (finish/abort/sweep) →
    // {status:'aborted', reason} so the agent doesn't claim "the user
    // clicked Done" when they actually cancelled or disconnected.
    const buildSettledResponse = () => {
      const reason = reviewSessions.getTerminalReason(id);
      if (reason === null || reason === 'done') {
        return { status: 'done' as const };
      }
      return { status: 'aborted' as const, reason };
    };

    if (timeoutMs > 0) {
      const pending = new Promise<'pending'>((resolve) => {
        const t = setTimeout(() => resolve('pending'), timeoutMs);
        if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
      });
      const winner = await Promise.race([
        doneWaiter.then(() => 'settled' as const),
        pending,
      ]);
      if (winner === 'pending') return c.json({ status: 'pending' });
      return c.json(buildSettledResponse());
    }

    await doneWaiter;
    return c.json(buildSettledResponse());
  });
}
