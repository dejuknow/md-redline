import type {
  AskInput,
  AskWaitResult,
  PostReviewResult,
  RequestReviewInput,
  ReviewInput,
  ToolCallContext,
  ToolCallResult,
  WaitForReviewResult,
  WaitInput,
  WaitResult,
} from './types';

const BATCH_PREAMBLE = (sessionId: string) =>
  `Review batch received (session ${sessionId}). Address ONLY the comments ` +
  `listed below. Leave any other comment markers in the file untouched.\n\n` +
  `IMPORTANT: After you finish addressing these comments, you MUST call ` +
  `mdr_request_review again with sessionId "${sessionId}" (no filePaths). ` +
  `The review is NOT complete. The user may have more feedback. ` +
  `Do not summarize or report to the user until the tool ` +
  `returns a "done" signal.\n\n===\n\n`;

const DONE_PREAMBLE =
  'Review handed off (final batch). The user has finished reviewing. ' +
  'Address ONLY the comments listed below. Leave any other comment markers ' +
  'in the file untouched. Do not poll for more feedback.\n\n===\n\n';

const DONE_NO_COMMENTS =
  'Review complete. The user has no more feedback. Continue with your original plan.';

const STILL_WAITING = (sessionId: string) =>
  `Review in progress. The user is still adding comments — the file(s) under ` +
  `review may contain unsubmitted @comment markers that are not yet part of ` +
  `any batch. You do not have permission to read, open, edit, or otherwise ` +
  `access the files under review while this session is active. You do not ` +
  `have permission to address @comment markers you discover by reading the ` +
  `file directly — they are not yours to act on until the user submits them. ` +
  `Call mdr_request_review again with sessionId "${sessionId}" (no filePaths) ` +
  `and wait. Only act on comments delivered to you in a "batch" or "done" ` +
  `tool result.`;

const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Process-scoped guard against double-opening a browser tab for the same
 * review URL. Defense-in-depth on top of the server's `created: false`
 * dedupe — even if the server lies, even if there's a race, even if macOS
 * `open URL` misbehaves, this set ensures `openInBrowser` fires at most
 * once per URL per MCP server lifetime (i.e. one Claude session).
 *
 * Lives in module scope intentionally: the MCP server is one long-lived
 * process per Claude session, and "have I already opened this URL?" is
 * exactly the question we need to answer.
 *
 * Bounded with FIFO eviction so a long-lived MCP process (days/weeks) that
 * accumulates many distinct review URLs can't grow this set without limit.
 * Evicting the oldest URL means it could re-open if revisited later, which
 * is an acceptable trade vs. unbounded memory growth.
 */
const OPENED_URLS_CAP = 1000;
const openedUrls = new Set<string>();

async function openBrowserOnce(
  fullUrl: string,
  openInBrowser: (url: string) => Promise<void>,
): Promise<void> {
  if (openedUrls.has(fullUrl)) return;
  if (openedUrls.size >= OPENED_URLS_CAP) {
    // Set iteration order is insertion order — drop the oldest entry.
    const oldest = openedUrls.values().next().value;
    if (oldest !== undefined) openedUrls.delete(oldest);
  }
  openedUrls.add(fullUrl);
  await openInBrowser(fullUrl).catch(() => {
    // Non-fatal — user can navigate manually.
  });
}

/** Test-only: clear the openedUrls set. Use in beforeEach. */
export function __resetOpenedBrowserUrlsForTests(): void {
  openedUrls.clear();
}

/**
 * How long (seconds) to wait before returning a 'pending' result so the
 * MCP client doesn't time out. Codex enforces a 120s hard limit per tool
 * call; 90s gives a comfortable buffer.
 */
const POLL_TIMEOUT_SECONDS = 90;

/**
 * The core tool-call handler. Pure function over an injected MdrClient and
 * callbacks — no SDK coupling, no module state. Tests can construct a mock
 * client and call it directly.
 *
 * Flow:
 *   1. grantAccess for every file path (throws if anything is outside allowed roots).
 *   2. createSession on the server, get back { sessionId, url }.
 *   3. openInBrowser the full URL (non-fatal if the OS call fails).
 *   4. Send an immediate sendProgress ping so the client sees activity.
 *   5. Set up a periodic progress timer every 10s.
 *   6. Long-poll waitForSession; if the AbortSignal fires, call abortSession
 *      so the /wait promise resolves promptly with an aborted result.
 *   7. Return a ToolCallResult with the prompt (handoff) or a descriptive
 *      "review not completed" message (abort/disconnect).
 */
export async function handleRequestReviewToolCall(
  input: RequestReviewInput,
  ctx: ToolCallContext,
): Promise<ToolCallResult> {
  // Continue mode: skip session creation, just re-poll for next batch
  if (input.mode === 'continue') {
    return handleContinueReviewToolCall(input.sessionId, {
      client: ctx.client,
      sendProgress: ctx.sendProgress,
      signal: ctx.signal,
    });
  }

  await ctx.client.grantAccess(input.filePaths);

  const session = await ctx.client.createSession({
    filePaths: input.filePaths,
    enableResolve: input.enableResolve,
  });

  const fullUrl = `${ctx.baseUrl.replace(/\/$/, '')}${session.url}`;
  // Server-side dedupe says "this is a fresh session" → open the browser.
  // The process-scoped `openBrowserOnce` ensures we never open the same URL
  // twice even if the server is wrong or there's a race.
  if (session.created !== false) {
    await openBrowserOnce(fullUrl, ctx.openInBrowser);
  }

  // Immediate "waiting" status so the client sees something right away.
  ctx.sendProgress?.(`mdr: waiting for your review at ${fullUrl}`);

  // Periodic progress updates while the long-poll is in flight. These keep
  // the tool call visibly alive in Claude Code's UI even though we have no
  // quantifiable progress to report.
  let elapsed = 0;
  const progressTimer = ctx.sendProgress
    ? setInterval(() => {
        elapsed += PROGRESS_INTERVAL_MS / 1000;
        ctx.sendProgress?.(`mdr: still waiting for your review (${elapsed}s elapsed)`);
      }, PROGRESS_INTERVAL_MS)
    : null;
  if (progressTimer && 'unref' in progressTimer) {
    (progressTimer as { unref: () => void }).unref();
  }

  // If the MCP client cancels the tool call, release the server-side session
  // immediately so we don't leave a 30-second orphan waiting for the
  // heartbeat sweep. The /abort POST resolves the waiter promise, which lets
  // the long-poll return with {status: 'aborted'}.
  const cancelListener = () => {
    void ctx.client.abortSession(session.sessionId).catch(() => {
      // Already released, network error, or the long-poll resolved first —
      // in any case the waiter will come back and we'll read the status below.
    });
  };
  if (ctx.signal?.aborted) {
    cancelListener();
  } else {
    ctx.signal?.addEventListener('abort', cancelListener, { once: true });
  }

  let result: WaitResult;
  try {
    result = await ctx.client.waitForSession(session.sessionId, POLL_TIMEOUT_SECONDS);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
  }

  if (result.status === 'pending') {
    return {
      content: [{ type: 'text', text: STILL_WAITING(session.sessionId) }],
    };
  }

  if (result.status === 'batch') {
    return {
      content: [{ type: 'text', text: BATCH_PREAMBLE(session.sessionId) + result.prompt }],
    };
  }

  if (result.status === 'done') {
    if (result.prompt) {
      return {
        content: [{ type: 'text', text: DONE_PREAMBLE + result.prompt }],
      };
    }
    return {
      content: [{ type: 'text', text: DONE_NO_COMMENTS }],
    };
  }

  // status === 'aborted'
  const reasonText =
    result.reason === 'browser_disconnected'
      ? 'the mdr browser tab was closed before review was completed'
      : 'the user cancelled the review';
  return {
    content: [
      {
        type: 'text',
        text: `Review was not completed (${reasonText}). No comments to address. Continue with your original plan.`,
      },
    ],
  };
}

export async function handleContinueReviewToolCall(
  sessionId: string,
  ctx: Pick<ToolCallContext, 'client' | 'sendProgress' | 'signal'>,
): Promise<ToolCallResult> {
  ctx.sendProgress?.(`mdr: waiting for next review batch (session ${sessionId})`);

  let elapsed = 0;
  const progressTimer = ctx.sendProgress
    ? setInterval(() => {
        elapsed += PROGRESS_INTERVAL_MS / 1000;
        ctx.sendProgress?.(`mdr: still waiting for next batch (${elapsed}s elapsed)`);
      }, PROGRESS_INTERVAL_MS)
    : null;
  if (progressTimer && 'unref' in progressTimer) {
    (progressTimer as { unref: () => void }).unref();
  }

  const cancelListener = () => {
    void ctx.client.abortSession(sessionId).catch(() => {});
  };
  if (ctx.signal?.aborted) {
    cancelListener();
  } else {
    ctx.signal?.addEventListener('abort', cancelListener, { once: true });
  }

  let result: WaitResult;
  try {
    result = await ctx.client.waitForSession(sessionId, POLL_TIMEOUT_SECONDS);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
  }

  if (result.status === 'pending') {
    return {
      content: [{ type: 'text', text: STILL_WAITING(sessionId) }],
    };
  }

  if (result.status === 'batch') {
    return {
      content: [{ type: 'text', text: BATCH_PREAMBLE(sessionId) + result.prompt }],
    };
  }

  if (result.status === 'done') {
    if (result.prompt) {
      return {
        content: [{ type: 'text', text: DONE_PREAMBLE + result.prompt }],
      };
    }
    return {
      content: [{ type: 'text', text: DONE_NO_COMMENTS }],
    };
  }

  const reasonText =
    result.reason === 'browser_disconnected'
      ? 'the mdr browser tab was closed before review was completed'
      : 'the user cancelled the review';
  return {
    content: [
      {
        type: 'text',
        text: `Review was not completed (${reasonText}). No comments to address. Continue with your original plan.`,
      },
    ],
  };
}

const ASK_PROGRESS_INTERVAL_MS = 10_000;

export async function handleAskToolCall(
  input: AskInput,
  ctx: Pick<ToolCallContext, 'client' | 'sendProgress' | 'signal'>,
): Promise<ToolCallResult> {
  let askId: string;
  try {
    const postResult = await ctx.client.postAgentComments(input.sessionId, input.questions);
    askId = postResult.askId;
  } catch (err) {
    const e = err as Error & { failedComments?: number[] };
    const detail =
      e.failedComments && e.failedComments.length > 0
        ? ` failedComments: ${JSON.stringify(e.failedComments)}`
        : '';
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `mdr_ask: ${e.message}${detail}`,
        },
      ],
    };
  }

  // Cancellation-race window: if the MCP signal fired between
  // postAgentComments resolving (server has written markers and registered
  // the pendingAsk) and the addEventListener('abort', ...) registration
  // below, the listener never fires and the server-side ask hangs until
  // the heartbeat sweep. Eager-check the signal now and fire releaseAsk
  // before we install the listener.
  if (ctx.signal?.aborted) {
    void ctx.client.releaseAsk(input.sessionId, askId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('HTTP 404')) {
        console.warn(`[mcp] releaseAsk on early-cancel failed for ${input.sessionId}/${askId}:`, err);
      }
    });
    return {
      content: [
        {
          type: 'text',
          text: `mdr_ask: tool call was cancelled before the user could reply. The questions were posted but the ask has been released.`,
        },
      ],
    };
  }

  ctx.sendProgress?.(`mdr: posted ${input.questions.length} question(s); waiting for your reply`);

  let elapsed = 0;
  const progressTimer = ctx.sendProgress
    ? setInterval(() => {
        elapsed += ASK_PROGRESS_INTERVAL_MS / 1000;
        ctx.sendProgress?.(`mdr: still waiting for your reply (${elapsed}s elapsed)`);
      }, ASK_PROGRESS_INTERVAL_MS)
    : null;
  if (progressTimer && 'unref' in progressTimer) {
    (progressTimer as { unref: () => void }).unref();
  }

  // The MCP cancel signal means "the agent gave up waiting" — not "destroy
  // the session." mdr_ask and mdr_review share a long-lived session, so
  // tearing it down on cancel would also discard the user's pending comments
  // in the browser. Release JUST this ask (resolves the waiter with
  // no_reply/released); the session lives on for any pending mdr_wait /
  // continued review.
  const cancelListener = () => {
    void ctx.client.releaseAsk(input.sessionId, askId).catch((err) => {
      // 404 = the ask was already resolved or released (expected — the
      // user may have answered just before cancel fired). Any other error
      // is a real failure worth surfacing on the server log.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('HTTP 404')) {
        console.warn(`[mcp] releaseAsk on cancel failed for ${input.sessionId}/${askId}:`, err);
      }
    });
  };
  if (ctx.signal?.aborted) {
    cancelListener();
  } else {
    ctx.signal?.addEventListener('abort', cancelListener, { once: true });
  }

  let askResult: AskWaitResult;
  try {
    // Intentionally NOT passing ctx.signal here. The cancelListener already
    // fires releaseAsk on cancel, which resolves the server-side waiter and
    // makes /asks/:askId/wait return {status:'released'}. Aborting the fetch
    // would race with that resolution and cause an AbortError before the
    // handler can return the graceful "released" payload.
    askResult = await ctx.client.waitForAsk(input.sessionId, askId);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
  }

  if (askResult.status === 'reply') {
    const replyCount = askResult.replies.length;
    const totalCount = askResult.totalQuestions;
    const countPhrase = replyCount === totalCount
      ? `all ${replyCount}`
      : `${replyCount} of ${totalCount}`;
    return {
      content: [
        {
          type: 'text',
          text:
            `mdr_ask: user replied to ${countPhrase} question(s).\n\n` +
            '```json\n' +
            JSON.stringify(askResult.replies, null, 2) +
            '\n```' +
            (replyCount < totalCount
              ? `\n\nAny comments without replies were not addressed this round.`
              : ''),
        },
      ],
    };
  }

  // status === 'no_reply'. Even on these paths the user may have engaged
  // another way (edited the document directly, or left a reply the server
  // could not match to the ask), so every reason except agent_silent tells
  // the agent to re-read the file before concluding the questions went
  // unanswered. agent_silent means no comments were ever posted, so there
  // is nothing in the file to read back.
  const READ_FILE_HINT =
    'Re-read the file(s) to pick up any inline replies or edits the user made, then continue with your plan.';
  const reasonDetails: Record<string, { text: string; hintReadFile: boolean }> = {
    released: { text: 'your tool call was cancelled before the user could reply', hintReadFile: true },
    tab_closed: { text: 'the mdr browser tab was closed before the user replied', hintReadFile: true },
    cancelled: { text: 'the user cancelled the review session before replying', hintReadFile: true },
    done_without_reply: { text: 'the user finished the review without replying to your questions', hintReadFile: true },
    timeout: { text: 'the review session timed out before the user replied', hintReadFile: true },
    agent_silent: { text: 'the session was closed because no comments were posted in time', hintReadFile: false },
  };
  const detail = reasonDetails[askResult.reason] ?? { text: askResult.reason, hintReadFile: true };
  const tail = detail.hintReadFile
    ? ` ${READ_FILE_HINT}`
    : ' Continue with your original plan, treating the questions as unanswered.';
  return {
    content: [
      {
        type: 'text',
        text: `mdr_ask: no reply received. Reason: ${detail.text}.${tail}`,
      },
    ],
  };
}

const WAIT_DONE =
  'User has finished engaging. Read the file to see their replies, deletions, and resolutions.';

const WAIT_STILL_REVIEWING = (sessionId: string) =>
  `The user is still reviewing. Call mdr_wait again with sessionId "${sessionId}" to keep waiting.`;

const WAIT_ABORTED_TEXT: Record<
  'user_cancelled' | 'browser_disconnected' | 'agent_silent' | 'finished',
  string
> = {
  user_cancelled:
    'Review session was cancelled by the user. Re-read the file(s) to pick up any replies or edits they made before cancelling, then continue with your plan.',
  browser_disconnected:
    'The mdr browser tab was closed. Closing the tab is a common way to finish a review: re-read the file(s) to pick up any replies or edits the user made before closing, then continue with your plan.',
  agent_silent:
    'The session timed out because no further activity was detected. No user feedback to apply.',
  finished:
    'The user closed the review (via Finish review) without engaging directly with your comments. Read the file for any user-side changes, then continue with your original plan.',
};

export async function handleWaitToolCall(
  input: WaitInput,
  ctx: Pick<ToolCallContext, 'client' | 'sendProgress' | 'signal'>,
): Promise<ToolCallResult> {
  ctx.sendProgress?.(`mdr: waiting for user to finish reviewing (session ${input.sessionId})`);

  let elapsed = 0;
  const progressTimer = ctx.sendProgress
    ? setInterval(() => {
        elapsed += PROGRESS_INTERVAL_MS / 1000;
        ctx.sendProgress?.(`mdr: still waiting for user review (${elapsed}s elapsed)`);
      }, PROGRESS_INTERVAL_MS)
    : null;
  if (progressTimer && 'unref' in progressTimer) {
    (progressTimer as { unref: () => void }).unref();
  }

  // MCP cancel signal during mdr_wait means "agent gave up." Do NOT abort
  // the session — the user is still engaging via the open browser tab, and
  // killing the session here would discard their pending comments and
  // surprise them. The long-poll itself terminates promptly when the fetch
  // is cancelled (the server's setTimeout race resolves to 'pending') so
  // there's nothing to clean up on the server side.
  const cancelListener = () => {
    /* no-op — see comment above */
  };
  if (ctx.signal?.aborted) {
    cancelListener();
  } else {
    ctx.signal?.addEventListener('abort', cancelListener, { once: true });
  }

  let result: WaitForReviewResult;
  try {
    // Intentionally NOT passing ctx.signal — the server-side long-poll has
    // its own 90s timeout, so a cancelled mdr_wait returns to the handler
    // within at most 90s without server-side cleanup. Aborting the fetch
    // would throw AbortError before any state can be reported back; the
    // existing 90s ceiling is the acceptable upper bound.
    result = await ctx.client.waitForReview(input.sessionId, POLL_TIMEOUT_SECONDS);
  } catch (err) {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
    const msg = err instanceof Error ? err.message : String(err);
    // The route returns 409 for user-origin sessions (mdr_wait is agent-only).
    // Surface a clearer hint so the agent doesn't loop on a misdirected
    // sessionId.
    if (msg.includes('HTTP 409')) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `mdr_wait: session ${input.sessionId} is user-origin and cannot be ` +
              'awaited via mdr_wait. Use mdr_request_review for the user-batch flow.',
          },
        ],
      };
    }
    // 404 = the server does not know this session. Most likely the mdr
    // server restarted (sessions are memory-only). The comments are still
    // in the file; there is just no live session to wait on.
    if (msg.includes('HTTP 404')) {
      return {
        content: [
          {
            type: 'text',
            text:
              `mdr_wait: session ${input.sessionId} is unknown to the server ` +
              '(it may have restarted; sessions do not survive restarts). ' +
              'Your comments are still in the file(s). Re-read them to pick up ' +
              'any replies or edits, then continue with your plan.',
          },
        ],
      };
    }
    throw err;
  }
  if (progressTimer) clearInterval(progressTimer);
  ctx.signal?.removeEventListener('abort', cancelListener);

  if (result.status === 'done') {
    return { content: [{ type: 'text', text: WAIT_DONE }] };
  }

  if (result.status === 'aborted') {
    return {
      content: [
        { type: 'text', text: WAIT_ABORTED_TEXT[result.reason] ?? `Review session ended (${result.reason}).` },
      ],
    };
  }

  // status === 'pending' — timed out, agent should re-poll
  return {
    content: [{ type: 'text', text: WAIT_STILL_REVIEWING(input.sessionId) }],
  };
}

/**
 * Handler for the mdr_review tool. The agent calls this to post comments (and
 * optionally replies) to a file and immediately returns. The agent should then
 * call mdr_wait to block until the user has finished engaging.
 *
 * Flow:
 *   1. grantAccess for every file path.
 *   2. createSession with origin='agent'.
 *   3. openInBrowser (non-fatal).
 *   4. postReview — always fire-and-forget.
 *   5. Return immediately, nudging agent to call mdr_wait.
 */
export async function handleReviewToolCall(
  input: ReviewInput,
  ctx: ToolCallContext,
): Promise<ToolCallResult> {
  // 1. Grant access
  await ctx.client.grantAccess(input.filePaths);

  // 2. Create agent-origin session
  const session = await ctx.client.createSession({
    filePaths: input.filePaths,
    enableResolve: input.enableResolve ?? false,
    origin: 'agent',
  });

  // Defensive assertion: createSession should always return an agent-origin
  // session here (the server filters dedupe by origin). If a future server
  // bug ever returns a user-origin session, fail loudly rather than tell the
  // agent to call mdr_wait — that combination would deadlock because
  // user-origin sessions don't resolve via setSessionDone.
  if (session.origin !== undefined && session.origin !== 'agent') {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `mdr_review: server returned a ${session.origin}-origin session, but mdr_review ` +
            `requires agent-origin. This is a server bug — file an issue.`,
        },
      ],
    };
  }

  const fullUrl = `${ctx.baseUrl.replace(/\/$/, '')}${session.url}`;
  if (session.created !== false) {
    await openBrowserOnce(fullUrl, ctx.openInBrowser);
  }
  ctx.sendProgress?.(`mdr: opening review at ${fullUrl}`);

  // 3. Post review (always fire-and-forget — no waitForAsk)
  let postResult: PostReviewResult;
  try {
    postResult = await ctx.client.postReview(session.sessionId, {
      comments: input.comments,
      replies: input.replies,
    });
  } catch (err) {
    const e = err as Error & { failedComments?: number[]; failedReplies?: number[] };
    const detailParts: string[] = [];
    if (e.failedComments?.length) detailParts.push(`failedComments: ${JSON.stringify(e.failedComments)}`);
    if (e.failedReplies?.length) detailParts.push(`failedReplies: ${JSON.stringify(e.failedReplies)}`);
    const detail = detailParts.length > 0 ? ` ${detailParts.join('; ')}` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `mdr_review: ${e.message}${detail}` }],
    };
  }

  // 4. Return immediately — nudge agent to call mdr_wait
  const fileList = input.filePaths.join(', ');
  return {
    content: [
      {
        type: 'text',
        text:
          `mdr_review: posted ${postResult.commentsWritten} comment(s) and ` +
          `${postResult.repliesWritten} reply(ies) to ${fileList}. ` +
          `Session ID: ${session.sessionId}. ` +
          `When you have finished posting all feedback, call mdr_wait with ` +
          `sessionId "${session.sessionId}" to block until the user has engaged.`,
      },
    ],
  };
}
