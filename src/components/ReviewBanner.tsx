import { useCallback, useState, useEffect, useRef } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import { isCommentSent } from '../lib/answered-comments';
import { pickHeaderSessions } from '../lib/header-session';
import type { ReviewSession } from '../hooks/useReviewSession';
import type { ShowToast } from '../hooks/useToast';
import { OtherReviews } from './ReviewHeaderMenus';
import { AgentSessionRow, PendingAskChip, SessionRow } from './ReviewRow';

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
  /** Called after a send that handed comments to the agent. */
  onHandoffSuccess?: (session: ReviewSession) => void;
  /**
   * Run at the click, before anything is posted. Reads the files' text as it
   * is now, waits for any write still out on them, and resolves to a commit
   * that records that text as the diff reference once the send succeeds, or
   * to null (after telling the reviewer why) if a write failed. The agent
   * reads the files on disk, so a send then would miss the latest comments.
   */
  prepareSend?: (filePaths: string[]) => Promise<(() => void) | null>;
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
  /**
   * `'banner'` (the default) is a bar of its own with one row per review.
   * `'header'` sits inside the app header: no bar styling, one row for the
   * review that needs the reviewer most (`pickHeaderSessions`), and a "+N"
   * button that lists the others in a popover with their full actions.
   */
  layout?: 'banner' | 'header';
  /**
   * Moves each row's quiet and secondary actions into a "More review
   * actions" menu. The primary action and the pending-question jump stay out.
   */
  compact?: boolean;
}

const NO_REPLIES: ReadonlyMap<string, string> = new Map();
const NO_OPTIMISTIC: OptimisticSent = { commentIds: new Set(), replyKeys: new Set() };
const NO_ASKS: Map<string, number> = new Map();

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
const NO_COMMIT = () => {};

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
  prepareSend,
  onResolved,
  onBatchSent,
  optimisticSent = NO_OPTIMISTIC,
  showToast,
  commentIdsByFile,
  userRepliedLast = NO_REPLIES,
  pendingAskCountsBySession,
  onJumpToAsk,
  layout = 'banner',
  compact = false,
}: ReviewBannerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // The review the header shows in its row. It stays there while it lasts
  // (see `pickHeaderSessions`), so a click never lands on another review's
  // button that took its place.
  const [shownId, setShownId] = useState<string | null>(null);
  // While the pointer is over the header's row, the row holds still.
  const [rowHovered, setRowHovered] = useState(false);
  // Sessions with a send in flight, claimed synchronously at the click,
  // before any await: a second click landing while the first waits on a save
  // must not post the same batch. Keyed by session, so another review's
  // buttons keep working meanwhile.
  const sendingRef = useRef(new Set<string>());
  // Sessions whose Send the server queued, mapped to how many sent ids the
  // session reported then. A finish right after must still wait on saves, and
  // the poll only reports `hasQueuedBatch` a few seconds later. Once a poll
  // shows more sent ids, its own flag is current and the entry goes.
  const [queuedHere, setQueuedHere] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    setQueuedHere((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const [id, sentAtQueue] of prev) {
        const live = sessions.find((x) => x.id === id);
        if (!live || live.sentCommentIds.length > sentAtQueue) next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  // `stayingOpen` is false for Send & finish: the session closes with that
  // send, so the prompt must not offer mdr_ask on it.
  const buildPromptForSession = useCallback(
    (s: ReviewSession, ids: string[] | undefined, stayingOpen: boolean): string => {
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
        askSessionId: stayingOpen ? s.id : undefined,
      });
    },
    [commentCounts],
  );

  const handleSendBatch = useCallback(
    async (s: ReviewSession) => {
      const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
      if (unsentIds.length === 0 || sendingRef.current.has(s.id)) return;
      sendingRef.current.add(s.id);
      const replyKeys = replyKeysFor(unsentIds, userRepliedLast);
      setBusyId(s.id);
      try {
        const commit = prepareSend ? await prepareSend(s.filePaths) : NO_COMMIT;
        if (!commit) return;
        const prompt = buildPromptForSession(s, unsentIds, true);
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
        commit();
        onHandoffSuccess?.(s);
        onBatchSent?.(unsentIds, replyKeys);
        if (data.queued) {
          setQueuedHere((prev) => new Map(prev).set(s.id, s.sentCommentIds.length));
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
        sendingRef.current.delete(s.id);
        setBusyId(null);
      }
    },
    [
      buildPromptForSession,
      prepareSend,
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
      const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
      // The agent reads the files when this finish carries comments: ours, or
      // a batch the server queued while the agent was busy (it folds that in).
      const carriesComments =
        unsentIds.length > 0 || s.hasQueuedBatch === true || queuedHere.has(s.id);
      if (sendingRef.current.has(s.id)) return;
      sendingRef.current.add(s.id);
      setBusyId(s.id);
      try {
        const commit = carriesComments && prepareSend ? await prepareSend(s.filePaths) : NO_COMMIT;
        if (!commit) return;
        const replyKeys = replyKeysFor(unsentIds, userRepliedLast);
        // A batch queued behind a busy agent is delivered with the finish, so
        // the server needs the counts to rebuild the prompt even when there
        // are no unsent ids of our own.
        const commentCountsForSession = commentCountsRecord(s, commentCounts);
        const body =
          unsentIds.length > 0
            ? {
                prompt: buildPromptForSession(s, unsentIds, false),
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
        // A finish with nothing new hands nothing off, so the diff keeps
        // showing the agent's last round instead of resetting to now.
        // A queued batch's files were recorded when it was sent.
        if (unsentIds.length > 0) {
          commit();
          onHandoffSuccess?.(s);
          onBatchSent?.(unsentIds, replyKeys);
        }
        showToast?.('Review finished and sent to agent', 'success');
        onResolved();
      } finally {
        sendingRef.current.delete(s.id);
        setBusyId(null);
      }
    },
    [
      buildPromptForSession,
      prepareSend,
      queuedHere,
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

  if (sessions.length === 0) {
    // The row unmounts without a pointerleave, so the next review's row must
    // not start out held.
    if (rowHovered) setRowHovered(false);
    return null;
  }

  // One review's row. `inline` is the header's single line, whose status
  // truncates; elsewhere (the standalone banner, the Other reviews popover)
  // a row may wrap.
  const renderRow = (
    s: ReviewSession,
    opts: { compact: boolean; inline: boolean; leading?: React.ReactNode },
  ) => {
    // Unified agent-reviewing row: covers both wait-mode (pending ask) and
    // fire-and-forget. Shape is always the same; only the status differs.
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
          compact={opts.compact}
          inline={opts.inline}
          leading={opts.leading}
        />
      );
    }

    const ready = sessionIsReady(s, commentCounts);
    const unsentIds = unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent);
    const disabled = busyId === s.id || !ready;
    const userSessionAskCount = pendingAskCountsBySession?.get(s.id) ?? 0;
    return (
      <SessionRow
        key={s.id}
        compact={opts.compact}
        inline={opts.inline}
        leading={opts.leading}
        indicator={<span className="inline-block h-2 w-2 rounded-full bg-warning" aria-hidden />}
        status={
          <>
            <strong>Agent is waiting on your review</strong> of{' '}
            {s.filePaths.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <code className="rounded bg-current/10 px-1">{getPathBasename(p)}</code>
              </span>
            ))}
            .
          </>
        }
        chip={
          userSessionAskCount > 0 && (
            <PendingAskChip
              count={userSessionAskCount}
              onJump={onJumpToAsk ? () => onJumpToAsk(s.id) : undefined}
            />
          )
        }
        quiet={{
          label: 'Cancel review',
          onClick: () => void handleCancel(s),
          disabled: busyId === s.id,
        }}
        secondary={{
          label: !ready
            ? 'Loading\u2026'
            : unsentIds.length > 0
              ? `Send ${unsentIds.length} & finish`
              : 'Finish review',
          onClick: () => void handleSendAndFinish(s),
          disabled: busyId === s.id || !ready,
        }}
        primary={{
          label: s.waitingForAgent
            ? 'Waiting for agent\u2026'
            : !ready
              ? 'Loading\u2026'
              : `Send ${unsentIds.length} comment${unsentIds.length === 1 ? '' : 's'}`,
          onClick: () => void handleSendBatch(s),
          disabled: disabled || s.waitingForAgent || unsentIds.length === 0,
          title: s.waitingForAgent
            ? 'Agent is processing previous batch'
            : !ready
              ? 'Loading file contents\u2026'
              : unsentIds.length === 0
                ? 'No new comments to send'
                : undefined,
        }}
      />
    );
  };

  if (layout === 'header') {
    const { primary, others } = pickHeaderSessions(
      sessions,
      pendingAskCountsBySession ?? NO_ASKS,
      (s) =>
        s.origin === 'user' &&
        sessionIsReady(s, commentCounts) &&
        !s.waitingForAgent &&
        unsentCommentIds(s, commentIdsByFile, userRepliedLast, optimisticSent).length > 0,
      { id: shownId, hold: rowHovered || (busyId !== null && busyId === shownId) },
    );
    const primaryId = primary?.id ?? null;
    // Remember what the row shows, so the next render keeps it.
    if (primaryId !== shownId) setShownId(primaryId);
    const othersButton = others.length > 0 && (
      <OtherReviews count={others.length}>
        {others.map((s) => renderRow(s, { compact: false, inline: false }))}
      </OtherReviews>
    );
    return (
      <div
        data-testid="review-banner"
        className="relative min-w-0 flex-1 flex items-center text-content"
        onPointerEnter={() => setRowHovered(true)}
        onPointerLeave={() => setRowHovered(false)}
      >
        {primary && renderRow(primary, { compact, inline: true, leading: othersButton })}
      </div>
    );
  }

  return (
    <div
      className="sticky top-0 z-40 border-b border-border bg-surface-secondary px-4 py-2 text-content"
      data-testid="review-banner"
    >
      {sessions.map((s) => renderRow(s, { compact, inline: false }))}
    </div>
  );
}
