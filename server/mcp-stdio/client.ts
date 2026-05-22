import type {
  AskQuestion,
  AskWaitResult,
  CreateSessionInput,
  CreateSessionResult,
  MdrClient,
  PostReviewArgs,
  PostReviewResult,
  WaitResult,
} from './types';

/**
 * HTTP client for the mdr web server. Used by the tool-call handler to
 * talk to the Hono API (grant access, create session, long-poll /wait,
 * POST /abort). Purely functional — no mutable state, no SDK coupling.
 */
export function createMdrClient(baseUrl: string): MdrClient {
  const url = (p: string) => `${baseUrl.replace(/\/$/, '')}${p}`;

  return {
    async grantAccess(paths) {
      for (const p of paths) {
        const res = await fetch(url('/api/grant-access'), {
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
      const res = await fetch(url('/api/review-sessions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
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
      const res = await fetch(url(path), {
        method: 'GET',
      });
      if (!res.ok) {
        throw new Error(`wait failed (HTTP ${res.status})`);
      }
      return (await res.json()) as WaitResult;
    },

    async abortSession(sessionId: string) {
      const res = await fetch(url(`/api/review-sessions/${sessionId}/abort`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `abort failed for ${sessionId} (HTTP ${res.status})`);
      }
    },

    async postAgentComments(sessionId: string, questions: AskQuestion[]) {
      const res = await fetch(url(`/api/review-sessions/${sessionId}/agent-comments`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questions }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; failedComments?: number[] };
        const err = new Error(body.error ?? `postAgentComments failed (HTTP ${res.status})`);
        if (body.failedComments) {
          (err as Error & { failedComments?: number[] }).failedComments = body.failedComments;
        }
        throw err;
      }
      return (await res.json()) as { askId: string };
    },

    async waitForAsk(sessionId: string, askId: string) {
      const res = await fetch(url(`/api/review-sessions/${sessionId}/asks/${askId}/wait`), {
        method: 'GET',
      });
      if (!res.ok) {
        throw new Error(`waitForAsk failed (HTTP ${res.status})`);
      }
      return (await res.json()) as AskWaitResult;
    },

    async postReview(sessionId: string, args: PostReviewArgs) {
      const res = await fetch(url(`/api/review-sessions/${sessionId}/agent-comments`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
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
      const res = await fetch(url(`/api/review-sessions/${sessionId}/asks/${askId}/release`), {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`releaseAsk failed (HTTP ${res.status})`);
    },
  };
}
