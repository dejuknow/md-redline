import { useEffect, useState, useCallback } from 'react';

export interface ReviewSession {
  id: string;
  filePaths: string[];
  enableResolve: boolean;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
  origin: 'user' | 'agent';
  /** ISO timestamp when the session was created. Always populated by the server's toPublic; used to tiebreak overlapping sessions for the same file. */
  createdAt: string;
  /** ISO timestamp of the last time the agent posted comments. Null until the first batch. */
  lastAgentActivityAt?: string | null;
}

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

// `origin` is intentionally excluded from equality: it is set at session
// creation and never mutates, so it cannot be the reason two fetches differ.
function sessionsEqual(a: ReviewSession[], b: ReviewSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.enableResolve !== y.enableResolve ||
      x.waitingForAgent !== y.waitingForAgent ||
      x.lastAgentActivityAt !== y.lastAgentActivityAt ||
      x.filePaths.length !== y.filePaths.length ||
      x.sentCommentIds.length !== y.sentCommentIds.length
    ) {
      return false;
    }
    for (let j = 0; j < x.filePaths.length; j++) {
      if (x.filePaths[j] !== y.filePaths[j]) return false;
    }
    for (let j = 0; j < x.sentCommentIds.length; j++) {
      if (x.sentCommentIds[j] !== y.sentCommentIds[j]) return false;
    }
  }
  return true;
}

export function useReviewSession() {
  const [sessions, setSessions] = useState<ReviewSession[]>([]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/review-sessions', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: ReviewSession[] };
      const open = data.sessions.filter((s) => s.status === 'open');
      // Preserve reference identity when nothing changed so downstream
      // consumers (MarkdownViewer's useLayoutEffect, sentCommentIds useMemo)
      // don't re-run and blow away in-progress text selections mid-drag.
      setSessions((prev) => (sessionsEqual(prev, open) ? prev : open));
    } catch {
      /* ignore — next poll will retry */
    }
  }, []);

  // Poll for sessions
  useEffect(() => {
    void fetchSessions();
    const id = setInterval(() => void fetchSessions(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchSessions]);

  // Heartbeat for each open session. Content-Type header is required by the
  // CSRF middleware, which otherwise rejects body-less POSTs with 415.
  //
  // An immediate heartbeat fires on mount so the session stays alive even if
  // the tab opened late, or if Chrome throttles the setInterval while the
  // tab is in the background. Without this, the first heartbeat wouldn't
  // fire until HEARTBEAT_INTERVAL_MS after the hook discovers the session,
  // which can easily race with the server's abandonment sweep.
  //
  // We also fire an immediate heartbeat on `pageshow` when the page is
  // restored from the back/forward cache (event.persisted === true). Tabs
  // that come back from bfcache are typically off-heartbeat for whatever
  // duration they were cached, and we want to refresh the lease the moment
  // they're alive again rather than wait up to HEARTBEAT_INTERVAL_MS.
  //
  // A 404/409 response means the session is gone server-side (swept or
  // resolved in another tab). Refresh the session list immediately so the
  // banner drops instead of waiting for the next 5s poll.
  useEffect(() => {
    if (sessions.length === 0) return;
    let cancelled = false;
    const sendHeartbeats = async () => {
      for (const s of sessions) {
        try {
          const res = await fetch(`/api/review-sessions/${s.id}/heartbeat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
          if (!cancelled && (res.status === 404 || res.status === 409)) {
            void fetchSessions();
            break;
          }
        } catch {
          /* next tick will retry */
        }
      }
    };
    void sendHeartbeats();
    const id = setInterval(() => void sendHeartbeats(), HEARTBEAT_INTERVAL_MS);
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void sendHeartbeats();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [sessions, fetchSessions]);

  const refresh = useCallback(() => void fetchSessions(), [fetchSessions]);

  return { sessions, refresh };
}

/**
 * Find the session that should drive UX for `filePath`. When multiple
 * sessions overlap on the same file (e.g. a user-origin session created
 * earlier and an agent-origin session opened by an `mdr_review` call),
 * prefer agent-origin first — the agent banner and ask UI take priority
 * over the user's own review flow. Within a tier, prefer the most-recently
 * created session so a freshly opened review wins over a stale one.
 */
export function findActiveSessionForFile(
  sessions: ReviewSession[],
  filePath: string | null,
): ReviewSession | null {
  if (!filePath) return null;
  // Explicit status filter: even though the API only returns open sessions
  // today, this keeps the invariant local — a terminal session sitting in
  // the local cache (e.g. between the abort and the next poll) must not be
  // returned as "active."
  const matches = sessions.filter(
    (s) => s.status === 'open' && s.filePaths.includes(filePath),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const parsedCreatedAt = (s: ReviewSession): number => {
    const t = Date.parse(s.createdAt);
    return Number.isFinite(t) ? t : 0;
  };
  // Tuple comparator: agent-origin first, then most-recent createdAt.
  // Avoids fudge-math (originRank * 1e15) that would break if epoch ms ever
  // exceed that magnitude.
  return matches.reduce((best, candidate) => {
    const candAgent = candidate.origin === 'agent';
    const bestAgent = best.origin === 'agent';
    if (candAgent !== bestAgent) return candAgent ? candidate : best;
    return parsedCreatedAt(candidate) > parsedCreatedAt(best) ? candidate : best;
  });
}
