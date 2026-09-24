import { randomUUID } from 'crypto';
import type {
  AskQuestion,
  AskWaitResult,
  AddFilesResult,
  BaselineInput,
  CaptureBaselineResult,
  CreateSessionInput,
  CreateSessionResult,
  ListBaselinesResult,
  MdrClient,
  PostReviewArgs,
  PostReviewResult,
  WaitResult,
} from './types';

/** The server rejects a longer clientId (POST /api/review-sessions). */
export const MAX_CLIENT_ID_LENGTH = 256;

/**
 * Caller identity, sent on createSession so the server's dedupe never merges
 * two different agents reviewing the same files into one session.
 *
 * A registered MCP server is one process per agent session, so a per-process
 * UUID is exactly "which agent is this." A client that starts a fresh
 * `mdr mcp` for every tool call (mcp2cli, a shell loop) would get a new UUID
 * each time and never reuse its own session, so it sets MD_REDLINE_CLIENT_ID
 * once per agent session instead (#121). An overlong value throws here, at
 * startup, rather than as a 400 on the first review.
 */
export function resolveClientId(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.MD_REDLINE_CLIENT_ID?.trim();
  if (!set) return `mcp_${randomUUID()}`;
  if (set.length > MAX_CLIENT_ID_LENGTH) {
    throw new Error(
      `MD_REDLINE_CLIENT_ID is ${set.length} characters; the limit is ${MAX_CLIENT_ID_LENGTH}.`,
    );
  }
  return set;
}

const PROCESS_CLIENT_ID = resolveClientId();

/**
 * Connection-level failures a server produces when it stops mid-request. A
 * client-side timeout (UND_ERR_HEADERS_TIMEOUT, say, while a long wait is still
 * legitimately parked) is deliberately NOT here: the server is still up, and
 * calling it gone would send the agent off to start over.
 */
const DROPPED_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE']);

/**
 * The mdr server was not running, or dropped a request in flight. Thrown in
 * place of Node's bare `fetch failed`, which told the agent nothing (#116).
 * A restart often comes from an `mdr` of a different version starting up,
 * which stops the running server as an upgrade step. Sessions now survive a
 * restart that comes back within a few minutes, so this no longer means the
 * review is gone: the long-poll methods retry through a restart on their own
 * (see `withReconnect` below), and this error only reaches a caller once
 * that retry has given up, or from a non-poll method, where the caller
 * decides whether to call again.
 */
export class ServerUnreachableError extends Error {
  readonly code: string;

  constructor(baseUrl: string, code: string) {
    const what =
      code === 'ECONNREFUSED'
        ? 'is not running (connection refused)'
        : `lost its connection to this call (${code}); it most likely stopped or restarted`;
    super(
      `The mdr server at ${baseUrl} ${what}. A restart often comes from another ` +
        'mdr install of a different version starting up. The review may still be ' +
        'there once it is back: call this tool again. Anything already written to ' +
        'the files is still there too, so re-read them if you want to check. Open ' +
        'a new review only if the next call says the session is gone.',
    );
    this.name = 'ServerUnreachableError';
    this.code = code;
  }
}

/**
 * Convert a network failure that means the server is gone. Node's fetch
 * rejects with `TypeError('fetch failed')` when the request fails, and a body
 * read rejects with `TypeError('terminated')` when the connection drops after
 * the headers arrived; either way the reason is on `cause.code` (an
 * AggregateError carries it too when both address families were tried).
 * Everything else passes through untouched: a caller's abort, an HTTP error
 * response, and any other network code, timeouts included.
 */
export function toServerError(err: unknown, baseUrl: string): unknown {
  if (!(err instanceof TypeError)) return err;
  if (err.message !== 'fetch failed' && err.message !== 'terminated') return err;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code !== 'ECONNREFUSED' && !(code && DROPPED_CODES.has(code))) return err;
  return new ServerUnreachableError(baseUrl, code);
}

/**
 * Wrap every client method so a server that is gone reads the same way from
 * each one, whether it failed on the request or while reading the response.
 */
function guardServerErrors<T extends object>(client: T, baseUrl: string): T {
  const guarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(client)) {
    guarded[key] =
      typeof value === 'function'
        ? async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (err) {
              throw toServerError(err, baseUrl);
            }
          }
        : value;
  }
  return guarded as T;
}

/** How often a long-poll re-issues its request while the server is unreachable. */
const RECONNECT_POLL_INTERVAL_MS = 1_000;

/**
 * How long a long-poll keeps retrying a ServerUnreachableError before giving
 * up and rethrowing (#116). A restart from a version switch or a crash
 * relaunch is usually back within a second or two; the window covers a
 * slower relaunch too, without leaving an agent parked forever on a server
 * that is really gone. Exported so tests can inject a short window instead
 * of waiting out the real one.
 */
export const RECONNECT_WINDOW_MS = 2 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `poll` on ServerUnreachableError, on a fixed interval, until
 * `windowMs` has passed since the first failure, then rethrow that error.
 *
 * Never past the poll's own deadline, though: a retried request asks only for
 * the seconds the original poll had left, and the retrying stops when they
 * run out. Without that, a restart mid-poll stacked a fresh 90 s poll on a
 * two-minute retry, and one tool call could run for several minutes, past
 * the limits some MCP hosts put on a call (Codex allows 120 s). An agent that
 * gets the error calls again, and that call's own startup check relaunches a
 * server that is still missing, which reloads the saved reviews.
 * `poll` must already be wrapped by guardServerErrors, so any network
 * failure it raises on a retry attempt arrives here as a
 * ServerUnreachableError too, not a raw fetch error; anything else (an HTTP
 * error response, a caller's own abort) is not this error's job and passes
 * straight through.
 *
 * None of the three long-poll methods take an AbortSignal today (waitForAsk
 * is cancelled via releaseAsk instead, and waitForSession/waitForReview rely
 * on the server's own timeout), so there is nothing to check between
 * retries yet. If one of them gains a signal later, this loop needs to stop
 * on it rather than keep sleeping.
 */
async function withReconnect<T>(
  poll: (timeoutSeconds?: number) => Promise<T>,
  timeoutSeconds: number | undefined,
  windowMs: number,
): Promise<T> {
  const pollDeadline = timeoutSeconds === undefined ? Infinity : Date.now() + timeoutSeconds * 1000;
  let giveUpAt: number | undefined;
  let attemptTimeout = timeoutSeconds;
  for (;;) {
    try {
      return await poll(attemptTimeout);
    } catch (err) {
      if (!(err instanceof ServerUnreachableError)) throw err;
      const now = Date.now();
      giveUpAt ??= Math.min(now + windowMs, pollDeadline);
      if (now + RECONNECT_POLL_INTERVAL_MS >= giveUpAt) throw err;
      await sleep(RECONNECT_POLL_INTERVAL_MS);
      if (timeoutSeconds !== undefined) {
        attemptTimeout = Math.max(1, Math.ceil((pollDeadline - Date.now()) / 1000));
      }
    }
  }
}

/**
 * Wrap the three long-poll methods of an already-guarded client so a
 * ServerUnreachableError retries instead of ending the call there. Kept as a
 * second pass over the guarded client, not folded into guardServerErrors
 * itself: guardServerErrors' job is giving every method the same "the
 * server is gone" error, and only these three calls should then sit and
 * retry it. Mixing that policy into the generic wrapper would hide, at a
 * glance, that a method like postReview is deliberately not one of them (it
 * fails once and reports it, so the caller decides whether to call again).
 */
function withReconnectingPolls(client: MdrClient, windowMs: number): MdrClient {
  return {
    ...client,
    waitForSession: (sessionId, timeoutSeconds) =>
      withReconnect((t) => client.waitForSession(sessionId, t), timeoutSeconds, windowMs),
    waitForAsk: (sessionId, askId, timeoutSeconds) =>
      withReconnect((t) => client.waitForAsk(sessionId, askId, t), timeoutSeconds, windowMs),
    waitForReview: (sessionId, timeoutSeconds) =>
      withReconnect((t) => client.waitForReview(sessionId, t), timeoutSeconds, windowMs),
  };
}

/**
 * HTTP client for the mdr web server. Used by the tool-call handler to
 * talk to the Hono API (grant access, create session, long-poll /wait,
 * POST /abort). Purely functional — no mutable state, no SDK coupling.
 *
 * `reconnectWindowMs` overrides RECONNECT_WINDOW_MS; tests use it to keep a
 * "the server never comes back" case from actually taking two minutes.
 */
export function createMdrClient(
  baseUrl: string,
  options: { reconnectWindowMs?: number } = {},
): MdrClient {
  const url = (p: string) => `${baseUrl.replace(/\/$/, '')}${p}`;
  const request = (p: string, init?: RequestInit) => fetch(url(p), init);
  const reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;

  const client = guardServerErrors<MdrClient>(
    {
      async grantAccess(paths) {
        for (const p of paths) {
          const res = await request('/api/grant-access', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: p }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `grant-access failed for ${p} (HTTP ${res.status})`);
          }
        }
      },

      async createSession(input: CreateSessionInput) {
        const res = await request('/api/review-sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: PROCESS_CLIENT_ID, ...input }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `createSession failed (HTTP ${res.status})`);
        }
        return (await res.json()) as CreateSessionResult;
      },

      async waitForSession(sessionId: string, timeoutSeconds?: number) {
        const path =
          timeoutSeconds !== undefined
            ? `/api/review-sessions/${sessionId}/wait?timeout=${timeoutSeconds}`
            : `/api/review-sessions/${sessionId}/wait`;
        const res = await request(path, {
          method: 'GET',
        });
        if (!res.ok) {
          throw new Error(`wait failed (HTTP ${res.status})`);
        }
        return (await res.json()) as WaitResult;
      },

      async abortSession(sessionId: string) {
        const res = await request(`/api/review-sessions/${sessionId}/abort`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `abort failed for ${sessionId} (HTTP ${res.status})`);
        }
      },

      async addSessionFiles(sessionId: string, filePaths: string[]) {
        const res = await request(`/api/review-sessions/${sessionId}/files`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filePaths }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          // The status rides along so the handler can tell an ended session
          // from other failures without matching the message text.
          throw Object.assign(
            new Error(body.error ?? `addSessionFiles failed (HTTP ${res.status})`),
            { status: res.status },
          );
        }
        return (await res.json()) as AddFilesResult;
      },

      async captureBaseline(input: BaselineInput) {
        const res = await request('/api/baselines', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `captureBaseline failed (HTTP ${res.status})`);
        }
        return (await res.json()) as CaptureBaselineResult;
      },

      async listBaselines() {
        const res = await request('/api/baselines', { method: 'GET' });
        if (!res.ok) return { baselines: [] };
        return (await res.json()) as ListBaselinesResult;
      },

      async getSessionFilePaths(sessionId: string) {
        const res = await request(`/api/review-sessions/${sessionId}`, { method: 'GET' });
        if (!res.ok) return [];
        const body = (await res.json().catch(() => ({}))) as { filePaths?: string[] };
        return body.filePaths ?? [];
      },

      async postAgentComments(sessionId: string, questions: AskQuestion[]) {
        // Intentionally NOT signal-aware: the server commits markers + creates
        // the pendingAsk during this POST, but the client receives the askId
        // only after it resolves. Aborting the fetch mid-flight would leave
        // the server with a live ask whose id the client never learned, so
        // the post-await cancelListener (which calls releaseAsk(askId)) can't
        // clean it up. The POST is bounded by the server's own request
        // handling — short by design.
        const res = await request(`/api/review-sessions/${sessionId}/agent-comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'ask', questions }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            failedComments?: number[];
          };
          const err = new Error(body.error ?? `postAgentComments failed (HTTP ${res.status})`);
          if (body.failedComments) {
            (err as Error & { failedComments?: number[] }).failedComments = body.failedComments;
          }
          throw err;
        }
        return (await res.json()) as { askId: string };
      },

      async waitForAsk(sessionId: string, askId: string, timeoutSeconds?: number) {
        const path = `/api/review-sessions/${sessionId}/asks/${askId}/wait`;
        const res = await request(
          timeoutSeconds !== undefined ? `${path}?timeout=${timeoutSeconds}` : path,
          { method: 'GET' },
        );
        if (!res.ok) {
          throw new Error(`waitForAsk failed (HTTP ${res.status})`);
        }
        return (await res.json()) as AskWaitResult;
      },

      async postReview(sessionId: string, args: PostReviewArgs) {
        const res = await request(`/api/review-sessions/${sessionId}/agent-comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'review',
            comments: args.comments,
            replies: args.replies,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            failedComments?: number[];
            failedReplies?: number[];
          };
          const err = new Error(body.error ?? `postReview failed (HTTP ${res.status})`);
          (err as Error & { failedComments?: number[] }).failedComments = body.failedComments;
          (err as Error & { failedReplies?: number[] }).failedReplies = body.failedReplies;
          throw err;
        }
        return (await res.json()) as PostReviewResult;
      },

      async releaseAsk(sessionId: string, askId: string) {
        const res = await request(`/api/review-sessions/${sessionId}/asks/${askId}/release`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`releaseAsk failed (HTTP ${res.status})`);
      },

      async waitForReview(sessionId: string, timeoutSeconds?: number) {
        const path =
          timeoutSeconds !== undefined
            ? `/api/review-sessions/${sessionId}/agent-wait?timeout=${timeoutSeconds}`
            : `/api/review-sessions/${sessionId}/agent-wait`;
        const res = await request(path, { method: 'GET' });
        if (!res.ok) {
          // 409 means the session exists but is the wrong origin for /agent-wait
          // (user-origin). Surface the route's specific error so the handler can
          // give the agent a clear next-step.
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const detail = body.error ? `: ${body.error}` : '';
          throw new Error(`waitForReview failed (HTTP ${res.status})${detail}`);
        }
        return (await res.json()) as import('./types').WaitForReviewResult;
      },
    },
    baseUrl,
  );

  return withReconnectingPolls(client, reconnectWindowMs);
}
