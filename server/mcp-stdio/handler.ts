import type {
  AskInput,
  AskWaitResult,
  PostReviewResult,
  RequestReviewInput,
  ReviewInput,
  ToolCallContext,
  ToolCallResult,
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
 */
const openedUrls = new Set<string>();

async function openBrowserOnce(
  fullUrl: string,
  openInBrowser: (url: string) => Promise<void>,
): Promise<void> {
  if (openedUrls.has(fullUrl)) return;
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

  const cancelListener = () => {
    void ctx.client.abortSession(input.sessionId).catch(() => {
      /* already gone */
    });
  };
  if (ctx.signal?.aborted) {
    cancelListener();
  } else {
    ctx.signal?.addEventListener('abort', cancelListener, { once: true });
  }

  let askResult: AskWaitResult;
  try {
    askResult = await ctx.client.waitForAsk(input.sessionId, askId);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
  }

  if (askResult.status === 'reply') {
    return {
      content: [
        {
          type: 'text',
          text:
            `mdr_ask: user replied to all ${askResult.replies.length} question(s).\n\n` +
            '```json\n' +
            JSON.stringify(askResult.replies, null, 2) +
            '\n```',
        },
      ],
    };
  }

  // status === 'no_reply'
  const reasonText = {
    released: 'the user released you (they may reply later)',
    tab_closed: 'the mdr browser tab was closed before you replied',
    cancelled: 'the user cancelled the review',
    timeout: 'the review session timed out',
    agent_silent: 'no comments were posted in time',
  }[askResult.reason] ?? askResult.reason;
  return {
    content: [
      {
        type: 'text',
        text: `mdr_ask: no reply received (${reasonText}). Continue with your original plan, treating the questions as unanswered.`,
      },
    ],
  };
}

/**
 * Handler for the mdr_review tool. The agent calls this to post comments (and
 * optionally replies) to a file and optionally wait for the user's response.
 *
 * Flow:
 *   1. grantAccess for every file path.
 *   2. createSession with origin='agent'.
 *   3. openInBrowser (non-fatal).
 *   4. Resolve waitForResponse from explicit input or user settings.
 *   5. postReview with the resolved expectsReply flag.
 *   6. If fire-and-forget, return immediately.
 *   7. If waiting, block on waitForAsk and return the reply or no_reply result.
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

  const fullUrl = `${ctx.baseUrl.replace(/\/$/, '')}${session.url}`;
  // Server-side dedupe says "this is a fresh session" → open the browser.
  // The process-scoped `openBrowserOnce` ensures we never open the same URL
  // twice even if the server is wrong or there's a race.
  if (session.created !== false) {
    await openBrowserOnce(fullUrl, ctx.openInBrowser);
  }
  ctx.sendProgress?.(`mdr: opening review at ${fullUrl}`);

  // 3. Resolve waitForResponse from input or user settings
  let expectsReply: boolean;
  if (typeof input.waitForResponse === 'boolean') {
    expectsReply = input.waitForResponse;
  } else {
    try {
      const settings = await ctx.getUserSettings?.();
      expectsReply = settings?.defaultAgentReviewWait ?? false;
    } catch {
      expectsReply = false;
    }
  }

  // 4. Post review
  let postResult: PostReviewResult;
  try {
    postResult = await ctx.client.postReview(session.sessionId, {
      comments: input.comments,
      replies: input.replies,
      expectsReply,
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

  // 5. Fire-and-forget: return now
  if (!expectsReply) {
    return {
      content: [
        {
          type: 'text',
          text: `mdr_review: wrote ${postResult.commentsWritten} comment(s) and ${postResult.repliesWritten} reply(ies) to the file(s). The user has been notified.`,
        },
      ],
    };
  }

  // 6. Wait for reply
  ctx.sendProgress?.(`mdr: posted ${postResult.commentsWritten} comment(s); waiting for your reply`);

  if (!postResult.askId) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'mdr_review: server did not return askId despite expectsReply=true' }],
    };
  }

  // Progress pings during the wait phase prevent the MCP client (Codex 120s
  // hard limit) from killing the call mid-wait.
  let reviewElapsed = 0;
  const reviewProgressTimer = ctx.sendProgress
    ? setInterval(() => {
        reviewElapsed += ASK_PROGRESS_INTERVAL_MS / 1000;
        ctx.sendProgress?.(`mdr: still waiting for your reply (${reviewElapsed}s elapsed)`);
      }, ASK_PROGRESS_INTERVAL_MS)
    : null;
  if (reviewProgressTimer && 'unref' in reviewProgressTimer) {
    (reviewProgressTimer as { unref: () => void }).unref();
  }

  // If the MCP client cancels the tool call, release the server-side session
  // immediately so the /wait promise resolves promptly.
  const reviewCancelListener = () => {
    void ctx.client.abortSession(session.sessionId).catch(() => {});
  };
  if (ctx.signal?.aborted) {
    reviewCancelListener();
  } else {
    ctx.signal?.addEventListener('abort', reviewCancelListener, { once: true });
  }

  let askResult: AskWaitResult;
  try {
    askResult = await ctx.client.waitForAsk(session.sessionId, postResult.askId);
  } finally {
    if (reviewProgressTimer) clearInterval(reviewProgressTimer);
    ctx.signal?.removeEventListener('abort', reviewCancelListener);
  }

  if (askResult.status === 'reply') {
    return {
      content: [
        {
          type: 'text',
          text:
            `mdr_review: user replied to ${askResult.replies.length} comment(s).\n\n` +
            '```json\n' +
            JSON.stringify(askResult.replies, null, 2) +
            '\n```',
        },
      ],
    };
  }

  // status === 'no_reply'
  const reviewReasonText = {
    released: 'the user released you and may reply later',
    tab_closed: 'the mdr browser tab was closed before you got a reply',
    cancelled: 'the user cancelled the review',
    timeout: 'the review session timed out',
    agent_silent: 'no comments were posted in time',
  }[askResult.reason] ?? askResult.reason;
  return {
    content: [
      {
        type: 'text',
        text: `mdr_review: no reply received (${reviewReasonText}). Comments are still in the file. Continue with your original plan.`,
      },
    ],
  };
}
