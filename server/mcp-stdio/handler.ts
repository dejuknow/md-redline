import type {
  RequestReviewInput,
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

const PROGRESS_INTERVAL_MS = 10_000;

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
  // Skip opening the browser when the server returned an existing session
  // for the same files — the tab is already open from the first call.
  if (session.created !== false) {
    await ctx.openInBrowser(fullUrl).catch(() => {
      // Browser open failures are non-fatal — the user can copy the URL.
    });
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
    result = await ctx.client.waitForSession(session.sessionId);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
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
    result = await ctx.client.waitForSession(sessionId);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    ctx.signal?.removeEventListener('abort', cancelListener);
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
