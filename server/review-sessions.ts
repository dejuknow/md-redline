import { randomUUID } from 'crypto';
import { buildAddressCommentsPrompt } from '../src/lib/agent-prompts';

/**
 * How long we keep a session alive without a heartbeat before assuming the
 * browser is gone. The browser UI heartbeats every 10s on the main thread.
 * Chrome throttles `setInterval` aggressively in backgrounded tabs, so a
 * tight (e.g. 30s) timeout silently kills sessions whenever the user tabs
 * away — the failure mode looks identical to "tab closed" from the server's
 * perspective even though the user is still there. The timeout is therefore
 * a crash-and-network-loss backstop, not a primary close detector. 30 min
 * is generous enough to ride out any realistic background-tab throttling.
 */
const HEARTBEAT_TIMEOUT_MS = 30 * 60_000;

/**
 * Maximum age of `lastHeartbeatAt` before `findOpenSession` will refuse to
 * dedupe to it. Without this gate, a crash-leaked session can sit in the
 * "open" pool for up to HEARTBEAT_TIMEOUT_MS, and a fresh
 * `mdr_request_review` for the same files would attach to it instead of
 * creating a new one.
 *
 * 5 minutes is well above the client's 10s heartbeat cadence (so live
 * sessions always pass, even when Chrome throttles background tabs to ~1
 * heartbeat per minute) and well below HEARTBEAT_TIMEOUT_MS. Set high
 * enough to accommodate agents that batch their work across multiple
 * `mdr_review` tool calls separated by minutes of LLM thinking time.
 */
const FIND_OPEN_FRESHNESS_MS = 5 * 60_000;

/**
 * How long to keep a terminal (done / aborted) session in memory after
 * it resolves. Keeps in-flight /wait and /:id lookups working for the
 * resolution moment, then lets the session age out so a long-running dev
 * server doesn't accumulate sessions forever.
 */
const TERMINAL_RETENTION_MS = 5 * 60_000;

/**
 * How long to wait before auto-clearing waitingForAgent. If the agent
 * doesn't call mdr_continue_review within this window, the user gets
 * unblocked to send another batch or finish the review.
 */
const WAITING_FOR_AGENT_TIMEOUT_MS = 60_000;

/**
 * How long an agent session can exist without posting any comments before
 * it is considered silent and aborted. 5 minutes is generous enough to
 * accommodate slow LLM tool calls while still giving users timely feedback
 * if the agent hangs.
 */
const AGENT_SILENT_TIMEOUT_MS = 5 * 60 * 1000;

export type ReviewResult =
  | { status: 'batch'; prompt: string; commentIds: string[] }
  | { status: 'done'; prompt?: string }
  | { status: 'aborted'; reason: 'user_cancelled' | 'browser_disconnected' | 'agent_silent' };

export interface AskQuestion {
  commentId: string;
  filePath: string;
  anchor: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * Reasons for a no_reply ask result.
 * - released: the agent cancelled its own mdr_ask tool call (cancelListener
 *   in handleAskToolCall fires releaseAsk on signal abort). No user-facing
 *   "Release agent" button exists today — this is exclusively an agent-side
 *   cancel signal.
 * - tab_closed: browser disconnected before user replied
 * - cancelled: user explicitly cancelled the review
 * - done_without_reply: user clicked Done on the agent banner while an ask
 *   was pending (they ended the session intentionally without replying)
 * - timeout: reserved for future session-timeout mechanism (not yet emitted)
 * - agent_silent: agent session created but no comments posted in time (see Task 16, not yet emitted)
 */
export type AskNoReplyReason =
  | 'released'
  | 'tab_closed'
  | 'cancelled'
  | 'done_without_reply'
  | 'timeout'
  | 'agent_silent';

export type AskResult =
  | { status: 'reply'; replies: Array<{ questionIndex: number; text: string }>; totalQuestions: number }
  | { status: 'no_reply'; reason: AskNoReplyReason };

export interface PendingAsk {
  askId: string;
  sessionId: string;
  questions: AskQuestion[];
}

interface InternalPendingAsk extends PendingAsk {
  resolver: (result: AskResult) => void;
  waiter: Promise<AskResult>;
}

export type SessionOrigin = 'user' | 'agent';

export interface ReviewSession {
  id: string;
  filePaths: string[];
  enableResolve: boolean;
  origin: SessionOrigin;
  createdAt: Date;
  lastHeartbeatAt: Date;
  /** ISO timestamp of the last time the agent posted comments. Null until the first batch. */
  lastAgentActivityAt: string | null;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
}

interface InternalSession extends Omit<ReviewSession, 'lastAgentActivityAt'> {
  resolver: (result: ReviewResult) => void;
  waiter: Promise<ReviewResult>;
  /** Set when the session transitions to a terminal state. Used for retention cleanup. */
  terminalAt: Date | null;
  /** When waitingForAgent was last set to true. Used for auto-clear timeout. */
  waitingForAgentSince: Date | null;
  /**
   * Batch queued while waitingForAgent was true. Delivered on the next agent
   * poll. We store the comment IDs + counts (not a prebuilt prompt) so that
   * if the user queues a SECOND batch on top of an already-queued one, we can
   * rebuild a single prompt from the union — concatenating prebuilt prompts
   * duplicates the system instructions and confuses the agent.
   */
  queuedBatch: { commentIds: string[]; commentCountsByPath: Map<string, number> } | null;
  /**
   * Total number of comments posted by the agent to this session.
   * Used by gcSilentAgentSessions to distinguish sessions where the agent has
   * already started working (and should not be GC'd) from ones that are truly
   * silent.
   */
  agentCommentCount: number;
  /**
   * The last time the agent successfully posted comments. Distinct from
   * lastHeartbeatAt (which is bumped by browser heartbeats too). Used by the
   * UI to show a spinner while the agent is actively posting and a static dot
   * when idle.
   */
  lastAgentActivityAt: Date | null;
  /**
   * Set when the user clicks Done in the UI (POST /agent-done).
   * Used by waitForSessionDone to unblock mdr_wait.
   */
  sessionDoneAt: Date | null;
  /**
   * Disambiguates why an agent-origin session ended. Set whenever the session
   * resolves a parked mdr_wait poll:
   *   'done'                — user clicked Done (setSessionDone)
   *   'finished'            — /finish was called (user-batch flow on the same session)
   *   'user_cancelled'      — /abort by user
   *   'browser_disconnected' — heartbeat sweep aborted
   *   'agent_silent'        — gcSilentAgentSessions aborted
   * Null until a terminal handler runs.
   */
  terminalReason:
    | 'done'
    | 'finished'
    | 'user_cancelled'
    | 'browser_disconnected'
    | 'agent_silent'
    | null;
  /** Resolves the waitForSessionDone promise. */
  doneResolver: (() => void) | null;
  /** The promise mdr_wait polls on. */
  doneWaiter: Promise<void> | null;
}

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
  origin?: SessionOrigin; // defaults to 'user'
}

export class ReviewSessionStore {
  private sessions = new Map<string, InternalSession>();
  private pendingAsks = new Map<string, InternalPendingAsk>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private onSessionAborted: ((sessionId: string, asks: PendingAsk[]) => void) | null = null;
  private onAsksClosedOnDone: ((sessionId: string, asks: PendingAsk[]) => void) | null = null;

  setOnSessionAborted(cb: (sessionId: string, asks: PendingAsk[]) => void): void {
    this.onSessionAborted = cb;
  }

  /**
   * Fired by setSessionDone when there were pending asks at the moment the
   * user clicked Done. Unlike onSessionAborted, the consumer is expected to
   * PRESERVE the markers on disk and only clear the `expectsReply` flag so
   * the file accurately reflects "asked, closed without reply" rather than
   * "still pending."
   */
  setOnAsksClosedOnDone(cb: (sessionId: string, asks: PendingAsk[]) => void): void {
    this.onAsksClosedOnDone = cb;
  }

  createSession(input: CreateSessionInput): ReviewSession {
    const id = `rev_${randomUUID()}`;
    const now = new Date();

    let resolver!: (result: ReviewResult) => void;
    const waiter = new Promise<ReviewResult>((resolve) => {
      resolver = resolve;
    });

    const session: InternalSession = {
      id,
      filePaths: [...input.filePaths],
      enableResolve: input.enableResolve,
      origin: input.origin ?? 'user',
      createdAt: now,
      lastHeartbeatAt: now,
      status: 'open',
      sentCommentIds: [],
      waitingForAgent: false,
      resolver,
      waiter,
      terminalAt: null,
      waitingForAgentSince: null,
      queuedBatch: null,
      agentCommentCount: 0,
      lastAgentActivityAt: null,
      sessionDoneAt: null,
      terminalReason: null,
      doneResolver: null,
      doneWaiter: null,
    };

    this.sessions.set(id, session);
    return this.toPublic(session);
  }

  getSession(id: string): ReviewSession | undefined {
    const s = this.sessions.get(id);
    return s ? this.toPublic(s) : undefined;
  }

  listOpenSessions(): ReviewSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.status === 'open')
      .map((s) => this.toPublic(s));
  }

  /**
   * Find an existing open session whose file paths match the given set
   * (order-independent). Used to deduplicate when the tool is called twice
   * for the same files. Requires a recent heartbeat so a crash-leaked
   * session doesn't get reused — see FIND_OPEN_FRESHNESS_MS.
   *
   * The `origin` filter is mandatory: agent-origin and user-origin sessions
   * have divergent terminal-state semantics (setSessionDone vs finish/abort),
   * so reusing a user-origin session for an agent request would deadlock the
   * agent's mdr_wait poll when the user clicks Finish or Cancel (those paths
   * never resolve `doneResolver`). Filter callers to match-on-origin.
   */
  findOpenSession(filePaths: string[], origin: SessionOrigin): ReviewSession | undefined {
    const sorted = [...filePaths].sort();
    const freshCutoff = Date.now() - FIND_OPEN_FRESHNESS_MS;
    for (const s of this.sessions.values()) {
      if (s.status !== 'open') continue;
      if (s.origin !== origin) continue;
      if (s.lastHeartbeatAt.getTime() < freshCutoff) continue;
      const existing = [...s.filePaths].sort();
      if (
        sorted.length === existing.length &&
        sorted.every((p, i) => p === existing[i])
      ) {
        return this.toPublic(s);
      }
    }
    return undefined;
  }

  /**
   * Returns the session's resolution promise. Throws if the session does not
   * exist — callers should check existence first (the HTTP layer already does).
   *
   * If a batch was queued while waitingForAgent was true, it is delivered
   * immediately: the current waiter is resolved with the queued batch, a new
   * waiter is installed for the next cycle, and the resolved (old) waiter is
   * returned so the caller receives the batch right away.
   *
   * Restricted to user-origin sessions. Agent-origin sessions resolve via
   * `waitForSessionDone` + `doneResolver`; calling waitForSession on one
   * would return a promise that never settles via the agent's terminal
   * path (only via the legacy resolver, which finish/abort/setSessionDone
   * also settle for symmetry — but that's defensive). Throw to catch
   * mis-wiring at the source rather than silently hanging.
   */
  waitForSession(id: string): Promise<ReviewResult> {
    const s = this.sessions.get(id);
    if (!s) {
      throw new Error(`Session not found: ${id}`);
    }
    if (s.origin !== 'user') {
      throw new Error(
        `waitForSession is only valid for user-origin sessions (got origin=${s.origin}); use waitForSessionDone for agent-origin`,
      );
    }
    s.waitingForAgent = false;
    s.waitingForAgentSince = null;

    // If a batch was queued while the agent was busy, deliver it now by
    // resolving the current waiter and returning it before replacing it.
    if (s.queuedBatch) {
      const queued = s.queuedBatch;
      s.queuedBatch = null;
      const prompt = buildAddressCommentsPrompt({
        filePaths: s.filePaths,
        commentCounts: queued.commentCountsByPath,
        enableResolve: s.enableResolve,
        commentIds: queued.commentIds,
      });
      const resolvedWaiter = s.waiter;
      s.resolver({ status: 'batch', prompt, commentIds: queued.commentIds });
      // Create a fresh waiter for the next poll cycle.
      let resolver!: (result: ReviewResult) => void;
      s.waiter = new Promise<ReviewResult>((resolve) => {
        resolver = resolve;
      });
      s.resolver = resolver;
      s.waitingForAgent = true;
      s.waitingForAgentSince = new Date();
      return resolvedWaiter;
    }

    return s.waiter;
  }

  /**
   * Mark a session as done from the user's side (Done button clicked).
   * Resolves any pending waitForSessionDone call immediately.
   * Idempotent — safe to call multiple times.
   *
   * Restricted to agent-origin sessions: this is the "user clicked Done in
   * the agent-review banner" path, which has no meaning for user-origin
   * sessions (they use finish/abort). Guarding here ensures a future caller
   * that wires this method up incorrectly can't silently deadlock the
   * legacy ReviewResult waiter for a user-origin session.
   */
  setSessionDone(id: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    if (s.origin !== 'agent') {
      throw new Error(
        `setSessionDone is only valid for agent-origin sessions (got origin=${s.origin})`,
      );
    }
    if (s.sessionDoneAt) return; // already done, idempotent
    const now = new Date();
    s.sessionDoneAt = now;
    s.terminalReason = 'done';
    // If the agent has a pending mdr_ask when the user clicks Done, resolve
    // its waiter with done_without_reply so the agent's tool call unblocks
    // with accurate semantics (the user finished intentionally without
    // replying). finish() and abort() handle their own paths via
    // abortAsks; setSessionDone uses a Done-specific reason here.
    //
    // Note: we intentionally do NOT pass abortAsks's return value to
    // onSessionAborted on this path — the markers should be preserved in
    // the file. The user clicked Done knowing the agent had pending
    // questions; leaving the marker in place is a useful record of "this
    // got asked, no answer." The abort-paths (tab_closed / cancelled /
    // agent_silent) still remove markers because there the session ended
    // unexpectedly.
    //
    // But we DO clear the `expectsReply` flag on those preserved markers
    // via the onAsksClosedOnDone callback so the on-disk state accurately
    // reflects "no longer pending." selectAgentAsks already filters by
    // sessionId, but the persisted flag should match the semantic.
    const closedAsks = this.abortAsks(id, 'done_without_reply');
    if (closedAsks.length > 0 && this.onAsksClosedOnDone) {
      try {
        this.onAsksClosedOnDone(id, closedAsks);
      } catch {
        /* swallow — cleanup is best-effort */
      }
    }
    // Mark terminal so listOpenSessions stops returning it and the UI banner
    // clears. The session remains queryable by id so a late mdr_wait poll
    // still gets the "done" signal.
    if (s.status === 'open') {
      s.status = 'done';
      s.terminalAt = now;
    }
    if (s.doneResolver) {
      s.doneResolver();
      s.doneResolver = null;
    }
    // Also settle the legacy ReviewResult waiter (s.resolver) for symmetry
    // with finish()/abort(). The /wait HTTP route 409s on agent-origin so
    // no production consumer awaits this promise today, but an in-process
    // helper that calls waitForSession(agentSessionId) would otherwise hang
    // until TERMINAL_RETENTION_MS GCs the session.
    s.resolver({ status: 'done' });
    // Remember the id and the precise reason past terminal retention so a
    // late mdr_wait poll still gets the right status after the session is
    // GC'd.
    this.rememberDoneSession(id, 'done');
    // Intentionally NOT firing onSessionAborted — see comment above. The
    // user's choice to click Done while questions were pending is a
    // deliberate "I'm done" signal, not an abort. Preserve markers.
  }

  /**
   * Bounded log of recently-completed session IDs and their terminal reason.
   * Used by `wasSessionDone` / `getTerminalReason` so a late `mdr_wait` poll
   * after TERMINAL_RETENTION_MS still resolves correctly (with the right
   * reason — not a blanket 'done') even after the session is GC'd from the
   * live map. Cap and FIFO eviction keep memory bounded over a long-lived
   * server.
   */
  private recentlyDoneIds = new Map<
    string,
    NonNullable<InternalSession['terminalReason']>
  >();
  private static RECENTLY_DONE_CAP = 1000;
  private rememberDoneSession(
    id: string,
    reason: NonNullable<InternalSession['terminalReason']>,
  ): void {
    if (this.recentlyDoneIds.has(id)) return;
    if (this.recentlyDoneIds.size >= ReviewSessionStore.RECENTLY_DONE_CAP) {
      const oldest = this.recentlyDoneIds.keys().next().value;
      if (oldest !== undefined) this.recentlyDoneIds.delete(oldest);
    }
    this.recentlyDoneIds.set(id, reason);
  }

  /**
   * True if the given session id ever reached a terminal state (Done, finish,
   * abort, sweep), even if the session has since been GC'd past
   * TERMINAL_RETENTION_MS.
   *
   * Note: the `recentlyDoneIds` map lives in process memory only — it does
   * NOT survive a server restart. After a restart, a late mdr_wait poll for
   * a session that completed before the restart will see 404. Acceptable for
   * a single-user dev tool; if you ever need durable wait semantics,
   * persist this set or extend TERMINAL_RETENTION_MS.
   */
  wasSessionDone(id: string): boolean {
    if (this.recentlyDoneIds.has(id)) return true;
    const s = this.sessions.get(id);
    return !!s?.sessionDoneAt;
  }

  /**
   * Returns a promise that resolves when setSessionDone is called.
   * If setSessionDone was already called, resolves immediately.
   * Throws if session does not exist.
   */
  waitForSessionDone(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    // Already done — resolve immediately
    if (s.sessionDoneAt) return Promise.resolve();
    // Lazily create the waiter
    if (!s.doneWaiter) {
      s.doneWaiter = new Promise<void>((resolve) => {
        s.doneResolver = resolve;
      });
    }
    return s.doneWaiter;
  }

  sendBatch(id: string, prompt: string, commentIds: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open' || s.waitingForAgent) return false;

    // Accumulate sent IDs
    for (const cid of commentIds) {
      if (!s.sentCommentIds.includes(cid)) {
        s.sentCommentIds.push(cid);
      }
    }

    // Resolve the current waiter
    s.resolver({ status: 'batch', prompt, commentIds });

    // Create a NEW waiter for the next batch/finish
    let resolver!: (result: ReviewResult) => void;
    s.waiter = new Promise<ReviewResult>((resolve) => {
      resolver = resolve;
    });
    s.resolver = resolver;
    s.waitingForAgent = true;
    s.waitingForAgentSince = new Date();

    return true;
  }

  /**
   * Queue a batch for delivery on the next agent poll. Used when the user
   * clicks Send batch while waitingForAgent is true (e.g. during a pending
   * mdr_ask). If a batch is already queued, merge with it: union of
   * commentIds, max-of per-file commentCounts. The prompt itself is
   * rebuilt at delivery time (in waitForSession) so back-to-back queue
   * merges don't double-up the system-instructions preamble.
   */
  queueBatch(
    id: string,
    commentIds: string[],
    commentCountsByPath: Map<string, number>,
  ): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    // Update sentCommentIds so the UI correctly disables the button after queuing.
    for (const cid of commentIds) {
      if (!s.sentCommentIds.includes(cid)) s.sentCommentIds.push(cid);
    }
    if (s.queuedBatch) {
      const mergedIds = Array.from(
        new Set([...s.queuedBatch.commentIds, ...commentIds]),
      );
      const mergedCounts = new Map(s.queuedBatch.commentCountsByPath);
      for (const [path, count] of commentCountsByPath) {
        const prev = mergedCounts.get(path) ?? 0;
        // Use the larger count — the file may have gained more comments
        // between the first and second queue call.
        if (count > prev) mergedCounts.set(path, count);
      }
      s.queuedBatch = {
        commentIds: mergedIds,
        commentCountsByPath: mergedCounts,
      };
    } else {
      s.queuedBatch = {
        commentIds: [...commentIds],
        commentCountsByPath: new Map(commentCountsByPath),
      };
    }
    return true;
  }

  /**
   * Returns true if a queued batch is pending delivery for this session.
   * The actual delivery happens inside waitForSession when it is next called.
   * This method exists so the route layer can log/detect queued delivery;
   * calling it has no side effects.
   */
  deliverQueuedBatchIfAny(id: string): boolean {
    const s = this.sessions.get(id);
    return !!(s?.queuedBatch);
  }

  getQueuedBatch(
    id: string,
  ): { commentIds: string[]; commentCountsByPath: Map<string, number> } | null {
    const queued = this.sessions.get(id)?.queuedBatch;
    if (!queued) return null;
    return {
      commentIds: [...queued.commentIds],
      commentCountsByPath: new Map(queued.commentCountsByPath),
    };
  }

  finish(id: string, prompt?: string, commentIds?: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;

    // Defensive: if anyone called finish while asks were pending, abort them.
    // Today the route layer's pending-ask 409 guard at POST /finish
    // unconditionally intercepts this, so the path is unreachable via HTTP.
    // It still runs for programmatic in-process callers (tests, internal
    // helpers) so stranded `agentInitiated` markers don't sit in the file —
    // same behavior as abort() / setSessionDone.
    const aborted = this.abortAsks(id, 'session_cancelled');

    if (commentIds) {
      for (const cid of commentIds) {
        if (!s.sentCommentIds.includes(cid)) {
          s.sentCommentIds.push(cid);
        }
      }
    }

    // Drop any queued batch — the session is closing.
    s.queuedBatch = null;
    s.status = 'done';
    s.terminalAt = new Date();
    if (prompt) {
      s.resolver({ status: 'done', prompt });
    } else {
      s.resolver({ status: 'done' });
    }
    // Unblock any pending mdr_wait. For an agent-origin session, /finish was
    // invoked via the user-batch flow rather than the agent banner's Done
    // button — surface that to the agent so it doesn't claim "the user
    // clicked Done" when they actually clicked Finish review.
    this.markDoneWaiterResolved(s, 'finished');
    if (aborted.length > 0 && this.onSessionAborted) {
      try {
        this.onSessionAborted(id, aborted);
      } catch {
        /* swallow — cleanup is best-effort */
      }
    }
    return true;
  }

  abort(id: string, reason: 'user_cancelled' | 'browser_disconnected' | 'agent_silent'): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    // Invariant: agent_silent only fires when agentCommentCount === 0
    // (see gcSilentAgentSessions), and addAsk requires the agent to have
    // posted comments first. So there should be no pending asks here. If
    // this ever changes, the askReason mapping below would mis-tag the
    // ask result as 'tab_closed' instead of 'agent_silent'.
    if (reason === 'agent_silent' && this.getPendingAsks(id).length > 0) {
      console.warn(
        `[review-session] invariant violation: agent_silent abort with pending asks (session ${id})`,
      );
    }
    const askReason = reason === 'user_cancelled' ? 'session_cancelled' : 'browser_disconnected';
    const aborted = this.abortAsks(id, askReason);
    // Drop any queued batch — it can't be delivered on an aborted session,
    // and holding the prompt + commentIds in memory until TERMINAL_RETENTION_MS
    // GC is wasteful.
    s.queuedBatch = null;
    s.status = 'aborted';
    s.terminalAt = new Date();
    s.resolver({ status: 'aborted', reason });
    // Unblock any pending mdr_wait with the actual abort reason so the agent
    // doesn't mistake an abort for a user-Done. wasSessionDone tracks the
    // id so a late mdr_wait after GC still resolves (falls back to 'done').
    this.markDoneWaiterResolved(s, reason);
    if (aborted.length > 0 && this.onSessionAborted) {
      try {
        this.onSessionAborted(id, aborted);
      } catch {
        /* callback errors are swallowed; cleanup is best-effort */
      }
    }
    return true;
  }

  /**
   * Resolve a pending mdr_wait poll and remember the session ID. Used by the
   * non-setSessionDone terminal paths (finish, abort, heartbeat-sweep) for
   * agent-origin sessions so a parked mdr_wait wakes up cleanly regardless
   * of which terminal path the session took. The caller passes the precise
   * reason so /agent-wait can return {status:'aborted', reason:'…'} for the
   * non-Done paths instead of a misleading {status:'done'}.
   */
  private markDoneWaiterResolved(
    s: InternalSession,
    reason: NonNullable<InternalSession['terminalReason']>,
  ): void {
    if (s.origin !== 'agent') return;
    if (!s.sessionDoneAt) s.sessionDoneAt = new Date();
    if (s.terminalReason === null) s.terminalReason = reason;
    if (s.doneResolver) {
      s.doneResolver();
      s.doneResolver = null;
    }
    this.rememberDoneSession(s.id, reason);
  }

  /**
   * Returns the precise terminal reason for an agent-origin session, if
   * known. Used by /agent-wait to distinguish "user clicked Done" from the
   * various abort paths so mdr_wait can report the right thing to the
   * agent. Falls back to `recentlyDoneIds` for sessions that have been GC'd
   * past TERMINAL_RETENTION_MS. Returns null only if the session was never
   * seen by this store (process restart, typo, etc.).
   */
  getTerminalReason(id: string): InternalSession['terminalReason'] {
    const s = this.sessions.get(id);
    if (s?.terminalReason) return s.terminalReason;
    return this.recentlyDoneIds.get(id) ?? null;
  }

  addAsk(
    sessionId: string,
    questions: AskQuestion[],
  ): { askId: string; waiter: Promise<AskResult> } {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'open') {
      throw new Error('session not found or already finished');
    }
    // Structural invariant: addAsk must run after recordAgentComments. The
    // route ensures this today, but encoding it here lets gcSilentAgentSessions
    // safely assume "no pending asks" when it fires (agentCommentCount===0).
    // Otherwise the agent_silent → tab_closed reason mapping in abortAsks
    // would silently mis-tag any racing ask result.
    if (s.origin === 'agent' && s.agentCommentCount === 0) {
      throw new Error(
        'addAsk requires the agent to have posted at least one comment first',
      );
    }
    for (const ask of this.pendingAsks.values()) {
      if (ask.sessionId === sessionId) {
        throw new Error('a previous mdr_ask is still pending; receive its reply first');
      }
    }
    const askId = `ask_${randomUUID()}`;
    let resolver!: (result: AskResult) => void;
    const waiter = new Promise<AskResult>((resolve) => {
      resolver = resolve;
    });
    this.pendingAsks.set(askId, {
      askId,
      sessionId,
      questions: [...questions],
      resolver,
      waiter,
    });
    return { askId, waiter };
  }

  waitForAsk(askId: string): Promise<AskResult> | undefined {
    const ask = this.pendingAsks.get(askId);
    return ask?.waiter;
  }

  resolveReplies(
    sessionId: string,
    askId: string,
    replies: Array<{ commentId: string; text: string }>,
  ): boolean {
    const ask = this.pendingAsks.get(askId);
    if (!ask || ask.sessionId !== sessionId) return false;
    const ordered: Array<{ questionIndex: number; text: string }> = [];
    ask.questions.forEach((q, idx) => {
      const reply = replies.find((r) => r.commentId === q.commentId);
      if (reply) ordered.push({ questionIndex: idx, text: reply.text });
    });
    // Partial replies are accepted — comments without a reply are implicit "no reply".
    ask.resolver({ status: 'reply', replies: ordered, totalQuestions: ask.questions.length });
    this.pendingAsks.delete(askId);
    return true;
  }

  abortAsks(
    sessionId: string,
    reason: 'session_cancelled' | 'browser_disconnected' | 'done_without_reply',
  ): PendingAsk[] {
    const noReplyReason: AskNoReplyReason =
      reason === 'browser_disconnected'
        ? 'tab_closed'
        : reason === 'done_without_reply'
          ? 'done_without_reply'
          : 'cancelled';
    const removed: PendingAsk[] = [];
    for (const [id, ask] of this.pendingAsks.entries()) {
      if (ask.sessionId !== sessionId) continue;
      ask.resolver({ status: 'no_reply', reason: noReplyReason });
      removed.push({ askId: ask.askId, sessionId: ask.sessionId, questions: ask.questions });
      this.pendingAsks.delete(id);
    }
    return removed;
  }

  releaseAsk(sessionId: string, askId: string): boolean {
    const ask = this.pendingAsks.get(askId);
    if (!ask || ask.sessionId !== sessionId) return false;
    this.pendingAsks.delete(askId);
    ask.resolver({ status: 'no_reply', reason: 'released' });
    return true;
  }

  /**
   * Increment the agent comment counter for a session. Call this after
   * comments are successfully written so gcSilentAgentSessions knows the
   * agent is active.
   */
  recordAgentComments(sessionId: string, count: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.agentCommentCount += count;
    const now = new Date();
    s.lastAgentActivityAt = now;
    // Treat an agent POST as a heartbeat so subsequent batched calls keep
    // finding this session via findOpenSession even if the browser tab is
    // backgrounded and Chrome throttles its setInterval-based heartbeats.
    s.lastHeartbeatAt = now;
  }

  /**
   * Inverse of recordAgentComments — used by the agent-comments route when
   * a write succeeds but a subsequent step (addAsk, downstream validation)
   * fails and rolls back the markers. Without this, agentCommentCount stays
   * inflated relative to actual on-disk markers, breaking the addAsk-
   * requires-comments invariant and the silent-GC eligibility for the
   * lifetime of the session.
   */
  unrecordAgentComments(sessionId: string, count: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.agentCommentCount = Math.max(0, s.agentCommentCount - count);
  }

  /**
   * Abort any open agent-origin sessions that have shown no activity within
   * AGENT_SILENT_TIMEOUT_MS. Called periodically to clean up hanging
   * sessions from agents that failed before posting OR before continuing.
   *
   * Activity is measured against `lastAgentActivityAt` (which the route
   * bumps for reply-only posts too) rather than `agentCommentCount` alone.
   * A long-running reply-only flow (agent posts comments, then replies for
   * several minutes) won't be silent-GC'd just because no NEW comments were
   * added. We still require `agentCommentCount > 0` as the protective
   * shortcut for established sessions.
   */
  gcSilentAgentSessions(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.status !== 'open') continue;
      if (s.origin !== 'agent') continue;
      // Once the agent has posted at least one comment, the session is
      // considered established; future activity is tracked by replies and
      // the heartbeat watchdog, not the silent-session GC.
      if (s.agentCommentCount > 0) continue;
      // Use lastAgentActivityAt if present (reply-only path), otherwise
      // fall back to createdAt for sessions where nothing has happened yet.
      const lastActivity = s.lastAgentActivityAt
        ? s.lastAgentActivityAt.getTime()
        : s.createdAt.getTime();
      if (now - lastActivity < AGENT_SILENT_TIMEOUT_MS) continue;
      this.abort(s.id, 'agent_silent');
    }
  }

  getPendingAsks(sessionId: string): PendingAsk[] {
    const result: PendingAsk[] = [];
    for (const ask of this.pendingAsks.values()) {
      if (ask.sessionId === sessionId) {
        result.push({ askId: ask.askId, sessionId: ask.sessionId, questions: ask.questions });
      }
    }
    return result;
  }

  /**
   * All pending asks across every session. Used by the file-save hook to
   * find asks whose questions may have just been answered inline, without
   * the caller having to know which session owns the file.
   */
  listPendingAsks(): PendingAsk[] {
    const result: PendingAsk[] = [];
    for (const ask of this.pendingAsks.values()) {
      result.push({ askId: ask.askId, sessionId: ask.sessionId, questions: ask.questions });
    }
    return result;
  }

  heartbeat(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    s.lastHeartbeatAt = new Date();
    return true;
  }

  startSweep(intervalMs: number): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    this.sweepHandle = setInterval(() => this.sweepStale(), intervalMs);
    if (typeof this.sweepHandle === 'object' && 'unref' in this.sweepHandle) {
      (this.sweepHandle as { unref: () => void }).unref();
    }
  }

  private sweepStale(): void {
    this.gcSilentAgentSessions();
    const now = Date.now();
    const heartbeatCutoff = now - HEARTBEAT_TIMEOUT_MS;
    const retentionCutoff = now - TERMINAL_RETENTION_MS;
    const agentTimeoutCutoff = now - WAITING_FOR_AGENT_TIMEOUT_MS;
    for (const [id, s] of this.sessions.entries()) {
      if (s.status === 'open') {
        if (s.lastHeartbeatAt.getTime() < heartbeatCutoff) {
          const aborted = this.abortAsks(id, 'browser_disconnected');
          s.status = 'aborted';
          s.terminalAt = new Date(now);
          s.resolver({ status: 'aborted', reason: 'browser_disconnected' });
          // Same as the explicit abort() path: wake any parked mdr_wait so
          // the agent doesn't hang waiting for a Done that will never come.
          this.markDoneWaiterResolved(s, 'browser_disconnected');
          if (aborted.length > 0 && this.onSessionAborted) {
            try {
              this.onSessionAborted(id, aborted);
            } catch {
              /* swallow */
            }
          }
        } else if (
          s.waitingForAgent &&
          s.waitingForAgentSince &&
          s.waitingForAgentSince.getTime() < agentTimeoutCutoff
        ) {
          // Agent didn't call mdr_continue_review in time. Unblock the
          // user so they can send another batch or finish the review.
          s.waitingForAgent = false;
          s.waitingForAgentSince = null;
        }
        continue;
      }
      // Terminal session — age it out once retention window has elapsed.
      if (s.terminalAt && s.terminalAt.getTime() < retentionCutoff) {
        this.sessions.delete(id);
      }
    }
  }

  dispose(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    for (const s of this.sessions.values()) {
      s.queuedBatch = null;
    }
    // Resolve any in-flight ask waiters BEFORE clearing the map. Otherwise
    // a `GET /api/.../asks/:askId/wait` handler holding a reference to the
    // waiter would hang indefinitely on dispose (matters most for tests).
    for (const ask of this.pendingAsks.values()) {
      ask.resolver({ status: 'no_reply', reason: 'cancelled' });
    }
    this.sessions.clear();
    this.pendingAsks.clear();
    this.recentlyDoneIds.clear();
  }

  private toPublic(s: InternalSession): ReviewSession {
    return {
      id: s.id,
      filePaths: [...s.filePaths],
      enableResolve: s.enableResolve,
      origin: s.origin,
      createdAt: s.createdAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      lastAgentActivityAt: s.lastAgentActivityAt ? s.lastAgentActivityAt.toISOString() : null,
      status: s.status,
      sentCommentIds: [...s.sentCommentIds],
      waitingForAgent: s.waitingForAgent,
    };
  }
}
