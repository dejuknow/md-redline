import { useCallback, useState, useEffect, useRef } from 'react';
import { getPathBasename } from '../lib/path-utils';
import { buildAddressCommentsPrompt } from '../lib/agent-prompts';
import { isCommentSent } from '../lib/answered-comments';
import { pickHeaderSessions } from '../lib/header-session';
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
  // The header's Other reviews popover.
  const [othersOpen, setOthersOpen] = useState(false);
  const othersRef = useRef<HTMLDivElement>(null);
  const closeOthers = useCallback(() => setOthersOpen(false), []);
  useDismiss(othersOpen, othersRef, closeOthers);
  // With one review left there is nothing behind the button: close the
  // popover so a later second review does not arrive with it already open.
  const hasOthers = sessions.length > 1;
  useEffect(() => {
    if (!hasOthers) setOthersOpen(false);
  }, [hasOthers]);
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

  if (sessions.length === 0) return null;

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
        indicator={<span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />}
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
    );
    // The popover hangs from the banner's right edge, not the button's, so
    // it has the row's width to open into rather than overflowing the left.
    const othersButton = others.length > 0 && (
      <div ref={othersRef} className="shrink-0">
        <button
          type="button"
          className={`h-7 px-2 rounded-md text-[13px] font-medium tabular-nums transition-colors ${
            othersOpen
              ? 'bg-tint text-content'
              : 'text-content-secondary hover:text-content hover:bg-tint'
          }`}
          onClick={() => setOthersOpen((open) => !open)}
          aria-label="Other reviews"
          aria-haspopup="dialog"
          aria-expanded={othersOpen}
          title={`${others.length} other review${others.length === 1 ? '' : 's'}`}
        >
          +{others.length}
        </button>
        {othersOpen && (
          <div
            role="dialog"
            aria-label="Other reviews"
            data-review-popover
            className="absolute right-0 top-full z-50 mt-1 w-[min(560px,calc(100vw-96px))] rounded-lg border border-border bg-surface shadow-lg px-3 py-1.5 divide-y divide-border-subtle"
          >
            {others.map((s) => renderRow(s, { compact: false, inline: false }))}
          </div>
        )}
      </div>
    );
    return (
      <div
        data-testid="review-banner"
        className="relative min-w-0 flex-1 flex items-center text-content"
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

/** One action of a review row, as a button or a More menu item. */
interface RowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

const actionBase =
  'h-7 shrink-0 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:opacity-40';
const QUIET_ACTION = `${actionBase} px-2 text-content-secondary hover:text-content hover:bg-tint`;
const SECONDARY_ACTION = `${actionBase} px-[11px] border border-border bg-surface text-content hover:bg-tint`;
const PRIMARY_ACTION = `${actionBase} px-3 bg-primary text-on-primary hover:bg-primary-hover`;
const MENU_ITEM =
  'w-full flex items-center px-3 py-1.5 text-left text-[13px] text-content whitespace-nowrap transition-colors hover:bg-tint disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

function ActionButton({ action, className }: { action: RowAction; className: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
      aria-label={action.ariaLabel}
    >
      {action.label}
    </button>
  );
}

/**
 * Closes a popup on a press outside `ref` or on Escape. Escape is caught on
 * the way down and stopped there, so App's own Escape handling never sees it.
 */
function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, ref, close]);
}

/** The compact row's overflow: its quiet and secondary actions, in that order. */
function MoreReviewActions({ items }: { items: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        className={`h-7 w-8 flex items-center justify-center rounded-md transition-colors ${
          open ? 'bg-tint text-content' : 'text-content-secondary hover:text-content hover:bg-tint'
        }`}
        onClick={() => setOpen((o) => !o)}
        aria-label="More review actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More review actions"
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More review actions"
          className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-lg border border-border bg-surface shadow-lg py-1"
        >
          {items.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={a.disabled}
              title={a.title}
              aria-label={a.ariaLabel}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  indicator: React.ReactNode;
  status: React.ReactNode;
  /** The pending-question jump. Stays out of the More menu when compact. */
  chip?: React.ReactNode;
  quiet?: RowAction;
  secondary?: RowAction;
  primary?: RowAction;
  /** Moves the quiet and secondary actions into a More menu. */
  compact: boolean;
  /** The header's single line: the status truncates instead of wrapping. */
  inline: boolean;
  /** Rendered first in the actions group (the header's Other reviews button). */
  leading?: React.ReactNode;
}

/**
 * The shared shape of every review row: status on the left, actions on the
 * right in the order quiet, chip, secondary, primary, so the primary is last.
 */
function SessionRow({
  indicator,
  status,
  chip,
  quiet,
  secondary,
  primary,
  compact,
  inline,
  leading,
}: SessionRowProps) {
  const overflow = [quiet, secondary].filter((a): a is RowAction => a !== undefined);
  return (
    <div
      className={
        inline
          ? 'min-w-0 flex-1 flex items-center gap-2'
          : 'flex flex-wrap items-center justify-between gap-2 py-1'
      }
    >
      <div className="min-w-0 flex items-center gap-2 text-[13px]">
        <span className="shrink-0 flex items-center">{indicator}</span>
        <span className={inline ? 'min-w-0 truncate' : 'min-w-0'}>{status}</span>
      </div>
      <div className="ml-auto shrink-0 flex items-center gap-2">
        {leading}
        {compact
          ? overflow.length > 0 && <MoreReviewActions items={overflow} />
          : quiet && <ActionButton action={quiet} className={QUIET_ACTION} />}
        {chip}
        {!compact && secondary && <ActionButton action={secondary} className={SECONDARY_ACTION} />}
        {primary && <ActionButton action={primary} className={PRIMARY_ACTION} />}
      </div>
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
  compact: boolean;
  inline: boolean;
  leading?: React.ReactNode;
}

const AGENT_ACTIVE_WINDOW_MS = 30_000;
const AGENT_TICK_MS = 5_000;

/**
 * Crimson-tinted chip surfacing "the agent is blocked on your answer." It sits
 * with the row's actions in every row variant and never folds into the More
 * menu; this is the persistent cue that outlives the toast.
 */
function PendingAskChip({ count, onJump }: { count: number; onJump?: () => void }) {
  const label = `${count} question${count === 1 ? '' : 's'} awaiting your reply`;
  const chipClass =
    'h-7 shrink-0 whitespace-nowrap inline-flex items-center rounded-md bg-primary-bg px-2.5 text-[13px] font-medium text-primary-text';
  if (!onJump) {
    return <span className={chipClass}>{label}</span>;
  }
  return (
    <button
      type="button"
      className={`${chipClass} hover:bg-primary-bg-strong transition-colors`}
      onClick={onJump}
      aria-label={`${label}. Jump to the first question.`}
    >
      {label} &rarr;
    </button>
  );
}

/**
 * Agent-origin row. Owns its own 5s ticking timer so the spinner-vs-dot
 * transition stays correct without forcing a re-render of every other row.
 * Mounting this component is the gate that creates the timer: when no
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
  compact,
  inline,
  leading,
}: AgentSessionRowProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGENT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // A session with no agent activity yet is one the agent just opened and is
  // about to post into: show the spinner, not the idle dot. The idle dot
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
    <SessionRow
      compact={compact}
      inline={inline}
      leading={leading}
      indicator={
        awaitingReply ? (
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-warning"
            aria-hidden
          />
        ) : isAgentActive ? (
          <span
            role="status"
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent"
            aria-label="Agent is active"
          />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-content-muted" aria-hidden />
        )
      }
      status={
        <>
          {awaitingReply ? (
            <strong>{agentName} is waiting on your reply.</strong>
          ) : (
            <strong>
              {agentName} is reviewing {fileList}.
            </strong>
          )}
          {!awaitingReply && agentCommentCount > 0 && (
            <span className="ml-2 text-content-secondary">
              ({agentCommentCount} comment{agentCommentCount === 1 ? '' : 's'})
            </span>
          )}
        </>
      }
      chip={
        awaitingReply && (
          <PendingAskChip
            count={pendingAskCount}
            onJump={onJumpToAsk ? () => onJumpToAsk(session.id) : undefined}
          />
        )
      }
      quiet={{
        label: 'End review',
        onClick: handleEndReview,
        disabled: busy,
        ariaLabel: `End review with ${agentName}`,
      }}
    />
  );
}
