import { useEffect, useState, useCallback } from 'react';

export interface ReviewSession {
  id: string;
  filePaths: string[];
  enableResolve: boolean;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
}

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

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
  // which can easily race with the server's 30s abandonment sweep.
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
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessions, fetchSessions]);

  const refresh = useCallback(() => void fetchSessions(), [fetchSessions]);

  return { sessions, refresh };
}
