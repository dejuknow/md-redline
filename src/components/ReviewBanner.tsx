import { useCallback, useState, useEffect } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import { isCommentSent } from '../lib/answered-comments';
import type { ReviewSession } from '../hooks/useReviewSession';
import type { ShowToast } from '../hooks/useToast';

/**
 * What this tab has just sent, before a session refresh reports it: comment
 * ids, and reply keys (`replyKey` in answered-comments.ts). Owned by the
 * parent, which also passes both to `onBatchSent`.
 */
export interface OptimisticSent {
  commentIds: ReadonlySet<string>;
  replyKeys: ReadonlySet<string>;
}

interface ReviewBannerProps {
  sessions: ReviewSession[];
  commentCounts: Map<string, number>;
  agentCommentCounts?: Map<string, number>;
  /** Called after a successful handoff so the parent can capture diff snapshots for the session's files. */
  onHandoffSuccess: (session: ReviewSession) => void;
  onResolved: () => void;
  /**
   * Called after a successful send (batch or send & finish) with the comment
   * IDs and reply keys that went out. The parent records them and hands them
   * back as `optimisticSent`, so what just went out reads as sent before the
   * next session refresh reports it.
   */
  onBatchSent?: (sentIds: string[], sentReplyKeys: string[]) => void;
  /** Sent ids and reply keys the parent has recorded ahead of the session. */
  optimisticSent?: OptimisticSent;
  /** Optional toast callback for brief confirmation and error messages. */
  showToast?: ShowToast;
  /** Comment IDs grouped by file path. */
  commentIdsByFile: Map<string, string[]>;
  /**
   * Open comments whose last reply is the reviewer's, mapped to that reply's
   * key. A sent comment is pending again for a reply not yet recorded as sent.
   */
  userRepliedLast?: ReadonlyMap<string, string>;
  /** Count of agent questions awaiting a reply, per session id. */
  pendingAskCountsBySession?: Map<string, number>;
  /** Scroll/focus the session's first pending agent question. */
  onJumpToAsk?: (sessionId: string) => void;
}

const NO_REPLIES: ReadonlyMap<string, string> = new Map();
const NO_OPTIMISTIC: OptimisticSent = { commentIds: new Set(), replyKeys: new Set() };

// A session is ready to send only when we have an authoritative comment count
// for every file it references. Tabs load asynchronously after `?review=<id>`
// opens them, and `commentCounts` is keyed by open tab paths. Without this
// guard, a click during the loading window would generate a "no changes,
// proceed" prompt using a zero count that is actually "not yet known."
function sessionIsReady(s: ReviewSession, commentCounts: Map<string, number>): boolean {
  return s.filePaths.every((p) => commentCounts.has(p));
}

// The session's comments that still need to go out. A comment is unsent until
// it is sent; a sent one counts as unsent again only when the reviewer's last
// reply on it is one that has not gone out yet. Sent means the session reports
// it or this tab has just sent it: the session lags the click by a refresh,
// and in that gap the same batch would otherwise be offered again.
// Judging by the reply rather than by "the agent has not answered yet" keeps a
// reply from being offered again while the agent is still working on it.
function unsentCommentIds(
  s: ReviewSession,
  commentIdsByFile: Map<string, string[]>,
  userRepliedLast: ReadonlyMap<string, string>,
  optimistic: OptimisticSent,
): string[] {
  const sentIds = new Set([...s.sentCommentIds, ...optimistic.commentIds]);
  const sentKeys = new Set([...(s.sentReplyIds ?? []), ...optimistic.replyKeys]);
  return s.filePaths
    .flatMap((p) => commentIdsByFile.get(p) ?? [])
    .filter((id) => !isCommentSent(id, sentIds, sentKeys, userRepliedLast));
}

// The reply keys a batch carries: the last reply of each thread being sent
// that has one. The server records them (as `replyIds`) so the thread is not
// offered again for the same reply text.
function replyKeysFor(ids: string[], userRepliedLast: ReadonlyMap<string, string>): string[] {
  return ids.flatMap((id) => userRepliedLast.get(id) ?? []);
}

// Per-file comment counts for a session's files, in the shape /batch and
// /finish accept. The server uses them to rebuild an accurate prompt when a
// queued batch is delivered (merged with other queued batches, or with the
// finishing send).
function commentCountsRecord(
  s: ReviewSession,
  commentCounts: Map<string, number>,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const p of s.filePaths) {
    record[p] = commentCounts.get(p) ?? 0;
  }
  return record;
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
  optimisticSent = NO_OPTIMISTIC,
  showToast,
  commentIdsByFile,
  userRepliedLast = NO_REPLIES,
  pendingAskCountsBySession,
  onJumpToAsk,
}: ReviewBannerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const buildPromptForSession = useCallback(
    (s: ReviewSession, ids?: string[]): string => {
      const totalComments = s.filePaths.reduce((sum, p) => sum + (commentCounts.get(p) ?? 0), 0);
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
      const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
      if (unsentIds.length === 0) return;
      const replyKeys = replyKeysFor(unsentIds, userRepliedLast);
      setBusyId(s.id);
      try {
        const prompt = buildPromptForSession(s, unsentIds);
        // Pass per-file commentCounts so the server can rebuild an accurate
        // prompt if this batch ends up merged into an existing queued one
        // (waitingForAgent path).
        const commentCountsForSession = commentCountsRecord(s, commentCounts);
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt,
              commentIds: unsentIds,
              replyIds: replyKeys,
              commentCounts: commentCountsForSession,
            }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Batch send failed: ${message}`, 'error');
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Batch send failed: ${detail}`, 'error');
          return;
        }
        const data = (await res.json()) as { ok: boolean; queued?: boolean };
        onHandoffSuccess(s);
        onBatchSent?.(unsentIds, replyKeys);
        if (data.queued) {
          showToast?.(
            `Queued ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'}: will send after your reply`,
            'success',
          );
        } else {
          showToast?.(
            `Sent ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'} to agent`,
            'success',
          );
        }
      } finally {
        setBusyId(null);
      }
    },
    [
      buildPromptForSession,
      commentIdsByFile,
      userRepliedLast,
      optimisticSent,
      commentCounts,
      onHandoffSuccess,
      onBatchSent,
      showToast,
    ],
  );

  const handleSendAndFinish = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
        const replyKeys = replyKeysFor(unsentIds, userRepliedLast);
        // A batch queued behind a busy agent is delivered with the finish, so
        // the server needs the counts to rebuild the prompt even when there
        // are no unsent ids of our own.
        const commentCountsForSession = commentCountsRecord(s, commentCounts);
        const body =
          unsentIds.length > 0
            ? {
                prompt: buildPromptForSession(s, unsentIds),
                commentIds: unsentIds,
                replyIds: replyKeys,
                commentCounts: commentCountsForSession,
              }
            : { commentCounts: commentCountsForSession };
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Finish failed: ${message}`, 'error');
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Finish failed: ${detail}`, 'error');
          return;
        }
        onHandoffSuccess(s);
        if (unsentIds.length > 0) onBatchSent?.(unsentIds, replyKeys);
        showToast?.('Review finished and sent to agent', 'success');
        onResolved();
      } finally {
        setBusyId(null);
      }
    },
    [
      buildPromptForSession,
      commentIdsByFile,
      commentCounts,
      userRepliedLast,
      optimisticSent,
      onHandoffSuccess,
      onBatchSent,
      onResolved,
      showToast,
    ],
  );

  const handleDone = useCallback(
    async (s: ReviewSession) => {
      setBusyId(s.id);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/review-sessions/${s.id}/agent-done`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'network error';
          showToast?.(`Couldn't end review: ${message}`, 'error');
          return;
        }
        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Couldn't end review: ${detail}`, 'error');
          return;
        }
        onResolved();
      } finally {
        setBusyId(null);
      }
    },
    [onResolved, showToast],
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
          showToast?.(`Cancel failed: ${message}`, 'error');
          return;
        }

        if (!res.ok) {
          const detail = await readErrorMessage(res);
          showToast?.(`Cancel failed: ${detail}`, 'error');
          return;
        }

        showToast?.('Review cancelled', 'info');
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
      className="sticky top-0 z-40 border-b border-border bg-surface-secondary px-4 py-2 text-content"
      data-testid="review-banner"
    >
      {sessions.map((s) => {
        // Unified agent-reviewing banner: covers both wait-mode (pending ask) and
        // fire-and-forget. Shape is always the same; only the button label differs.
        if (s.origin === 'agent') {
          // Stored on the session by the server (#113), so it does not depend
          // on which files are open or whether the agent only replied.
          const agentName = s.author ?? 'Agent';
          const agentCommentCount = s.filePaths.reduce(
            (sum, p) => sum + (agentCommentCounts?.get(p) ?? 0),
            0,
          );
          return (
            <AgentSessionRow
              key={s.id}
              session={s}
              agentName={agentName}
              agentCommentCount={agentCommentCount}
              pendingAskCount={pendingAskCountsBySession?.get(s.id) ?? 0}
              busy={busyId === s.id}
              onDone={handleDone}
              onJumpToAsk={onJumpToAsk}
            />
          );
        }

        const ready = sessionIsReady(s, commentCounts);
        const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
        const disabled = busyId === s.id || !ready;
        const userSessionAskCount = pendingAskCountsBySession?.get(s.id) ?? 0;
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
                  <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
                </span>
              ))}
              .
              {userSessionAskCount > 0 && (
                <PendingAskChip
                  count={userSessionAskCount}
                  onJump={onJumpToAsk ? () => onJumpToAsk(s.id) : undefined}
                />
              )}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className="rounded bg-primary text-on-primary px-3 py-1 text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-40"
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
                className="rounded border border-border bg-surface text-content-secondary px-3 py-1 text-sm font-medium hover:bg-tint hover:text-content transition-colors disabled:opacity-40"
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
                className="rounded px-2 py-1 text-sm text-content-secondary hover:text-content hover:bg-tint transition-colors disabled:opacity-50"
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

interface AgentSessionRowProps {
  session: ReviewSession;
  agentName: string;
  agentCommentCount: number;
  pendingAskCount: number;
  busy: boolean;
  onDone: (s: ReviewSession) => void;
  onJumpToAsk?: (sessionId: string) => void;
}

const AGENT_ACTIVE_WINDOW_MS = 30_000;
const AGENT_TICK_MS = 5_000;

/**
 * Warning-palette chip surfacing "the agent is blocked on your answer."
 * Rendered in both banner row variants; this is the persistent cue that
 * outlives the toast.
 */
function PendingAskChip({ count, onJump }: { count: number; onJump?: () => void }) {
  const label = `${count} question${count === 1 ? '' : 's'} awaiting your reply`;
  if (!onJump) {
    return (
      <span className="ml-2 rounded bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-text">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ml-2 rounded bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-text hover:underline"
      onClick={onJump}
      aria-label={`${label}. Jump to the first question.`}
    >
      {label} &rarr;
    </button>
  );
}

/**
 * Agent-origin banner row. Owns its own 5s ticking timer so the spinner-vs-dot
 * transition stays correct without forcing a re-render of every other banner.
 * Mounting this component is the gate that creates the timer — when no
 * agent-origin sessions are open, no timer runs.
 */
function AgentSessionRow({
  session,
  agentName,
  agentCommentCount,
  pendingAskCount,
  busy,
  onDone,
  onJumpToAsk,
}: AgentSessionRowProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGENT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // A session with no agent activity yet is one the agent just opened and is
  // about to post into — show the spinner, not the idle dot. The idle dot
  // means "the agent posted a while ago and has gone quiet."
  const isAgentActive = session.lastAgentActivityAt
    ? now - new Date(session.lastAgentActivityAt).getTime() < AGENT_ACTIVE_WINDOW_MS
    : true;
  const awaitingReply = pendingAskCount > 0;

  const handleEndReview = () => {
    if (awaitingReply) {
      const confirmed = window.confirm(
        `${agentName} has ${pendingAskCount} unanswered question${pendingAskCount === 1 ? '' : 's'}. ` +
          'End the review anyway? Unanswered questions will be reported back as unanswered.',
      );
      if (!confirmed) return;
    }
    onDone(session);
  };

  const fileList = (
    <>
      {session.filePaths.map((p, i) => (
        <span key={p}>
          {i > 0 && ', '}
          <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
        </span>
      ))}
    </>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1">
      <span className="text-sm flex items-center">
        {awaitingReply ? (
          <span
            className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-warning align-middle"
            aria-hidden
          />
        ) : isAgentActive ? (
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
        {awaitingReply ? (
          <strong>{agentName} is waiting on your reply.</strong>
        ) : (
          <strong>
            {agentName} is reviewing {fileList}.
          </strong>
        )}
        {awaitingReply ? (
          <PendingAskChip
            count={pendingAskCount}
            onJump={onJumpToAsk ? () => onJumpToAsk(session.id) : undefined}
          />
        ) : (
          agentCommentCount > 0 && (
            <span className="ml-2 text-content-secondary">
              ({agentCommentCount} comment{agentCommentCount === 1 ? '' : 's'})
            </span>
          )
        )}
      </span>
      <button
        type="button"
        className="rounded bg-primary text-on-primary px-3 py-1 text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-40"
        onClick={handleEndReview}
        disabled={busy}
        aria-label={`End review with ${agentName}`}
      >
        End review
      </button>
    </div>
  );
}
