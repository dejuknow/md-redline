import { useCallback, useState, useEffect } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import type { ReviewSession } from '../hooks/useReviewSession';

export interface PendingAskSummary {
  askId: string;
  commentIds: string[];
  agentName: string;
  readyCount: number;
}

interface ReviewBannerProps {
  sessions: ReviewSession[];
  commentCounts: Map<string, number>;
  agentCommentCounts?: Map<string, number>;
  /** Called after a successful handoff so the parent can capture diff snapshots for the session's files. */
  onHandoffSuccess: (session: ReviewSession) => void;
  onResolved: () => void;
  /** Called after a successful batch POST with the IDs that were sent. Parent uses this for optimistic UI update. */
  onBatchSent?: (sentIds: string[]) => void;
  /** Optional toast callback for brief confirmation and error messages. */
  showToast?: (message: string) => void;
  /** Comment IDs grouped by file path. */
  commentIdsByFile: Map<string, string[]>;
  /** Pending asks per session id — drives the awaiting-reply banner state. */
  pendingAsksBySession?: Map<string, PendingAskSummary>;
  /** Called when the user clicks Send replies. Can be async; banner manages busy state during the call. */
  onSendReplies?: (sessionId: string, askId: string) => void | Promise<void>;
  /** Called after the user successfully releases the agent so the parent can clear pending-ask UI state. */
  onRelease?: (sessionId: string) => void;
  /** Agent name per session id — used for the completion banner in fire-and-forget sessions. */
  agentNamesBySession?: Map<string, string>;
}

// A session is ready to send only when we have an authoritative comment count
// for every file it references. Tabs load asynchronously after `?review=<id>`
// opens them, and `commentCounts` is keyed by open tab paths. Without this
// guard, a click during the loading window would generate a "no changes,
// proceed" prompt using a zero count that is actually "not yet known."
function sessionIsReady(s: ReviewSession, commentCounts: Map<string, number>): boolean {
  return s.filePaths.every((p) => commentCounts.has(p));
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
  } catch {
    /* non-JSON body, fall through */
  }
  return `HTTP ${res.status}`;
}

export function ReviewBanner({
  sessions,
  commentCounts,
  agentCommentCounts,
  onHandoffSuccess,
  onResolved,
  onBatchSent,
  showToast,
  commentIdsByFile,
  pendingAsksBySession,
  onSendReplies,
  onRelease,
  agentNamesBySession,
}: ReviewBannerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  // Self-ticking timer to drive the spinner/dot decision without relying on
  // external polling cadence. Ticks every 5s to match the session poll interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const buildPromptForSession = useCallback(
    (s: ReviewSession, ids?: string[]): string => {
      const totalComments = s.filePaths.reduce(
        (sum, p) => sum + (commentCounts.get(p) ?? 0),
        0,
      );
      if (totalComments === 0 && (!ids || ids.length === 0)) {
        const list = s.filePaths.map((p) => `\`${p}\``).join(', ');
        return `I reviewed the following files and had no changes. Please proceed: ${list}.`;
      }
      return buildAddressCommentsPrompt({
        filePaths: s.filePaths,
        commentCounts,
        enableResolve: s.enableResolve,
        commentIds: ids,
      });
    },
    [commentCounts],
  );

  const handleSendBatch = useCallback(
    async (s: ReviewSession) => {
      const sessionIds = s.filePaths.flatMap((p) => commentIdsByFile.get(p) ?? []);
      const unsentIds = sessionIds.filter((id) => !s.sentCommentIds.includes(id));
      if (unsentIds.length === 0) return;
      setBusyId(s.id);
      try {
        const prompt = buildPromptForSession(s, unsentIds);
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt, commentIds: unsentIds }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Batch send failed: ${message}`);
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Batch send failed: ${detail}`);
          return;
        }
        const data = (await res.json()) as { ok: boolean; queued?: boolean };
        onHandoffSuccess(s);
        onBatchSent?.(unsentIds);
        if (data.queued) {
          showToast?.(`Queued ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'}: will send after your reply`);
        } else {
          showToast?.(`Sent ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'} to agent`);
        }
      } finally {
        setBusyId(null);
      }
    },
    [buildPromptForSession, commentIdsByFile, onHandoffSuccess, onBatchSent, showToast],
  );

  const handleSendAndFinish = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        const sessionIds = s.filePaths.flatMap((p) => commentIdsByFile.get(p) ?? []);
        const unsentIds = sessionIds.filter((id) => !s.sentCommentIds.includes(id));
        let res: Response;
        try {
          if (unsentIds.length > 0) {
            const prompt = buildPromptForSession(s, unsentIds);
            res = await fetch(`/api/review-sessions/${s.id}/finish`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt, commentIds: unsentIds }),
            });
          } else {
            res = await fetch(`/api/review-sessions/${s.id}/finish`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Finish failed: ${message}`);
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Finish failed: ${detail}`);
          return;
        }
        onHandoffSuccess(s);
        showToast?.('Review finished and sent to agent');
        onResolved();
      } finally {
        setBusyId(null);
      }
    },
    [buildPromptForSession, commentIdsByFile, onHandoffSuccess, onResolved, showToast],
  );

  const handleSendReplies = useCallback(
    async (sessionId: string, askId: string) => {
      if (!onSendReplies) return;
      setBusyId(sessionId);
      try {
        await onSendReplies(sessionId, askId);
      } finally {
        setBusyId(null);
      }
    },
    [onSendReplies],
  );

  const handleRelease = useCallback(
    async (sessionId: string, askId: string) => {
      setBusyId(sessionId);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${sessionId}/asks/${askId}/release`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Release failed: ${message}`);
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Release failed: ${detail}`);
          return;
        }
        showToast?.('Agent released. Comments stay in the file.');
        onRelease?.(sessionId);
      } finally {
        setBusyId(null);
      }
    },
    [showToast, onRelease],
  );

  const handleCancel = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/abort`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Cancel failed: ${message}`);
          return;
        }

        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Cancel failed: ${detail}`);
          return;
        }

        showToast?.('Review cancelled');
        onResolved();
      } finally {
        setBusyId(null);
      }
    },
    [onResolved, showToast],
  );

  const handleDismissAgentSession = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/abort`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Dismiss failed: ${message}`);
          return;
        }

        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Dismiss failed: ${detail}`);
          return;
        }

        onResolved();
      } finally {
        setBusyId(null);
      }
    },
    [onResolved, showToast],
  );

  if (sessions.length === 0) return null;

  return (
    <div
      className="sticky top-0 z-40 border-b border-primary/30 bg-primary-bg px-4 py-2 text-primary-text"
      data-testid="review-banner"
    >
      {sessions.map((s) => {
        const ask = pendingAsksBySession?.get(s.id);
        if (ask && ask.commentIds.length > 0) {
          const readyCount = ask.readyCount;
          const allReady = readyCount === ask.commentIds.length;
          const askSessionIds = s.filePaths.flatMap((p) => commentIdsByFile.get(p) ?? []);
          const askUnsentIds = askSessionIds.filter((id) => !s.sentCommentIds.includes(id));
          return (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="text-sm">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full bg-primary align-middle"
                  aria-hidden
                />
                <strong>{ask.agentName} has {ask.commentIds.length} question{ask.commentIds.length === 1 ? '' : 's'}</strong>{' '}
                on {s.filePaths.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
                  </span>
                ))}.
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="rounded bg-primary text-on-primary px-3 py-1 text-sm font-semibold hover:bg-primary-hover disabled:opacity-50"
                  onClick={() => void handleSendReplies(s.id, ask.askId)}
                  disabled={busyId === s.id || !allReady}
                  title={allReady ? undefined : `${readyCount} of ${ask.commentIds.length} replies drafted`}
                >
                  Send replies ({readyCount}/{ask.commentIds.length})
                </button>
                {askUnsentIds.length > 0 && (
                  <button
                    type="button"
                    className="rounded border-2 border-primary text-primary-text bg-surface px-3 py-1 text-sm font-semibold hover:bg-primary-bg-strong disabled:opacity-50"
                    onClick={() => void handleSendBatch(s)}
                    disabled={busyId === s.id}
                  >
                    Send {askUnsentIds.length} comment{askUnsentIds.length === 1 ? '' : 's'}
                  </button>
                )}
                <button
                  type="button"
                  className="px-2 py-1 text-sm text-primary-text hover:underline disabled:opacity-50"
                  onClick={() => void handleRelease(s.id, ask.askId)}
                  disabled={busyId === s.id}
                >
                  Release agent
                </button>
                <button
                  type="button"
                  className="px-2 py-1 text-sm text-primary-text hover:underline disabled:opacity-50"
                  onClick={() => void handleCancel(s)}
                  disabled={busyId === s.id}
                >
                  Cancel review
                </button>
              </span>
            </div>
          );
        }

        // Unified agent-reviewing banner: stays up for the entire active review,
        // showing a live comment count as batches arrive. Clears only on Dismiss.
        if (s.origin === 'agent') {
          const agentName = agentNamesBySession?.get(s.id) ?? 'Agent';
          const agentCommentCount = s.filePaths.reduce(
            (sum, p) => sum + (agentCommentCounts?.get(p) ?? 0),
            0,
          );
          const fileBasenames = s.filePaths.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
            </span>
          ));
          const AGENT_ACTIVE_WINDOW_MS = 30_000;
          const isAgentActive = s.lastAgentActivityAt
            ? now - new Date(s.lastAgentActivityAt).getTime() < AGENT_ACTIVE_WINDOW_MS
            : false;
          return (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="text-sm flex items-center">
                {isAgentActive ? (
                  <span
                    role="status"
                    className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent align-middle"
                    aria-label="Agent is active"
                  />
                ) : (
                  <span
                    className="mr-2 inline-block h-2 w-2 rounded-full bg-primary align-middle"
                    aria-hidden
                  />
                )}
                <strong>{agentName} is reviewing {fileBasenames}</strong>
                {agentCommentCount > 0 && (
                  <span className="ml-2 text-secondary-text">
                    — {agentCommentCount} comment{agentCommentCount === 1 ? '' : 's'} so far
                  </span>
                )}
              </span>
              <button
                type="button"
                className="px-2 py-1 text-sm text-primary-text hover:underline disabled:opacity-50"
                onClick={() => void handleDismissAgentSession(s)}
                disabled={busyId === s.id}
              >
                Dismiss
              </button>
            </div>
          );
        }

        const ready = sessionIsReady(s, commentCounts);
        const sessionIds = s.filePaths.flatMap((p) => commentIdsByFile.get(p) ?? []);
        const unsentIds = sessionIds.filter((id) => !s.sentCommentIds.includes(id));
        const disabled = busyId === s.id || !ready;
        return (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-sm">
              <span
                className="mr-2 inline-block h-2 w-2 rounded-full bg-success align-middle"
                aria-hidden
              />
              <strong>Agent is waiting on your review</strong> of{' '}
              {s.filePaths.map((p, i) => (
                <span key={p}>
                  {i > 0 && ', '}
                  <code className="rounded bg-current/10 px-1">
                    {getPathBasename(p)}
                  </code>
                </span>
              ))}
              .
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className="rounded bg-primary text-on-primary px-3 py-1 text-sm font-semibold hover:bg-primary-hover disabled:opacity-50"
                onClick={() => void handleSendBatch(s)}
                disabled={disabled || s.waitingForAgent || unsentIds.length === 0}
                title={
                  s.waitingForAgent
                    ? 'Agent is processing previous batch'
                    : !ready
                      ? 'Loading file contents\u2026'
                      : unsentIds.length === 0
                        ? 'No new comments to send'
                        : undefined
                }
              >
                {s.waitingForAgent
                  ? 'Waiting for agent\u2026'
                  : !ready
                    ? 'Loading\u2026'
                    : `Send ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                className="rounded border-2 border-primary text-primary-text bg-surface px-3 py-1 text-sm font-semibold hover:bg-primary-bg-strong disabled:opacity-50"
                onClick={() => void handleSendAndFinish(s)}
                disabled={busyId === s.id || !ready}
              >
                {!ready
                  ? 'Loading\u2026'
                  : unsentIds.length > 0
                    ? `Send ${unsentIds.length} & finish`
                    : 'Finish review'}
              </button>
              <button
                type="button"
                className="px-2 py-1 text-sm text-primary-text hover:underline disabled:opacity-50"
                onClick={() => void handleCancel(s)}
                disabled={busyId === s.id}
              >
                Cancel review
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
