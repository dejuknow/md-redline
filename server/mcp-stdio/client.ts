import type {
  CreateSessionInput,
  CreateSessionResult,
  MdrClient,
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

    async waitForSession(sessionId: string) {
      const res = await fetch(url(`/api/review-sessions/${sessionId}/wait`), {
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
  };
}
