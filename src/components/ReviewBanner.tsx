import { useCallback, useState } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import type { ReviewSession } from '../hooks/useReviewSession';

interface ReviewBannerProps {
  sessions: ReviewSession[];
  commentCounts: Map<string, number>;
  enableResolve: boolean;
  /** Called after a successful handoff so the parent can capture diff snapshots for the session's files. */
  onHandoffSuccess: (session: ReviewSession) => void;
  onResolved: () => void;
  /** Called after a successful batch POST with the IDs that were sent. Parent uses this for optimistic UI update. */
  onBatchSent?: (sentIds: string[]) => void;
  /** Optional toast callback for brief confirmation and error messages. */
  showToast?: (message: string) => void;
  /** All comment IDs currently in the files. */
  commentIds: string[];
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
  enableResolve,
  onHandoffSuccess,
  onResolved,
  onBatchSent,
  showToast,
  commentIds,
}: ReviewBannerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

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
        enableResolve: s.enableResolve || enableResolve,
        commentIds: ids,
      });
    },
    [commentCounts, enableResolve],
  );

  const handleSendBatch = useCallback(
    async (s: ReviewSession) => {
      const unsentIds = commentIds.filter((id) => !s.sentCommentIds.includes(id));
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
        onHandoffSuccess(s);
        onBatchSent?.(unsentIds);
        showToast?.(`Sent ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'} to agent`);
      } finally {
        setBusyId(null);
      }
    },
    [buildPromptForSession, commentIds, onHandoffSuccess, onBatchSent, showToast],
  );

  const handleSendAndFinish = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        const unsentIds = commentIds.filter((id) => !s.sentCommentIds.includes(id));
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
    [buildPromptForSession, commentIds, onHandoffSuccess, onResolved, showToast],
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

  if (sessions.length === 0) return null;

  return (
    <div
      className="sticky top-0 z-40 border-b border-warning/30 bg-warning-bg px-4 py-2 text-warning-text"
      data-testid="review-banner"
    >
      {sessions.map((s) => {
        const ready = sessionIsReady(s, commentCounts);
        const unsentIds = commentIds.filter((id) => !s.sentCommentIds.includes(id));
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
                className="rounded border-2 border-current px-3 py-1 text-sm font-semibold hover:bg-current/10 disabled:opacity-50"
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
                    : 'Send batch'}
              </button>
              <button
                type="button"
                className="rounded border-2 border-current px-3 py-1 text-sm font-semibold hover:bg-current/10 disabled:opacity-50"
                onClick={() => void handleSendAndFinish(s)}
                disabled={busyId === s.id || !ready}
              >
                {!ready ? 'Loading\u2026' : unsentIds.length > 0 ? 'Send & finish' : 'Finish review'}
              </button>
              <button
                type="button"
                className="rounded border border-current/40 px-3 py-1 text-sm hover:bg-current/10 disabled:opacity-50"
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
