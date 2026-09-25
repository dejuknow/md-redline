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
 * Longest agent name kept on a session, the cap `mdr baseline` uses. The name
 * goes to every open tab on every poll, so an overlong one is cut here.
 */
export const MAX_SESSION_AUTHOR_LEN = 64;

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
 * `mdr_comment` tool calls separated by minutes of LLM thinking time.
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
  | {
      status: 'reply';
      replies: Array<{ questionIndex: number; text: string }>;
      totalQuestions: number;
    }
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
  /**
   * Opaque caller identity used to scope dedupe. Two MCP server processes
   * (e.g. Claude and Codex reviewing the same file) send distinct clientIds
   * and get distinct sessions; without this they would merge into one
   * session and a single Done would resolve both agents' mdr_wait polls.
   */
  clientId?: string;
  createdAt: Date;
  lastHeartbeatAt: Date;
  /** ISO timestamp of the last time the agent posted comments. Null until the first batch. */
  lastAgentActivityAt: string | null;
  /**
   * The name the agent posts under, from the first batch that supplied one.
   * The banner reads it here rather than mining it back out of comment
   * markers, which missed reply-only sessions and files with no open tab
   * (#113).
   */
  author?: string;
  /**
   * When each file added after creation arrived (#117), ISO strings keyed by
   * path. A tab uses it to tell a file added after the tab loaded, which it
   * opens, from one that was already there, which it leaves alone.
   */
  fileAddedAt?: Record<string, string>;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
}

/**
 * Disambiguates why an agent-origin session ended, and why a terminal
 * user-origin session's ReviewResult waiter resolved the way it did (see
 * InternalSession.terminalReason for the per-value meaning). Named and
 * exported so PersistedSession can carry the same value across a restart.
 */
export type SessionTerminalReason =
  | 'done'
  | 'finished'
  | 'user_cancelled'
  | 'browser_disconnected'
  | 'agent_silent'
  | null;

interface InternalSession extends Omit<ReviewSession, 'lastAgentActivityAt'> {
  /** The files the session was created with, before any addFiles (#117). */
  originalFilePaths: string[];
  resolver: (result: ReviewResult) => void;
  waiter: Promise<ReviewResult>;
  /**
   * Number of /wait requests currently parked on this session's waiter,
   * maintained by the route layer via beginWaitPark/endWaitPark. sendBatch
   * delivers directly only while this is > 0; otherwise the batch must be
   * queued. Resolving the waiter with nobody parked loses the batch:
   * sendBatch installs a fresh waiter immediately, so a poll arriving later
   * parks on the fresh one and the resolved result is unreachable. This is
   * not a theoretical race — the MCP client re-polls /wait?timeout=90, so
   * an unparked window opens every 90 seconds in normal operation.
   */
  parkedWaitCount: number;
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
  terminalReason: SessionTerminalReason;
  /** Resolves the waitForSessionDone promise. */
  doneResolver: (() => void) | null;
  /** The promise mdr_wait polls on. */
  doneWaiter: Promise<void> | null;
  /**
   * The ReviewResult a terminal session's legacy waiter was resolved with,
   * captured at the same moment as the resolve call. Restoring a store after
   * a restart (#116) replays this into a freshly-resolved waiter, so an
   * agent whose /wait poll reconnects after the process comes back still
   * gets the final prompt or abort reason it would have gotten without the
   * restart. Null until a terminal path runs. Also set on agent-origin
   * sessions, which resolve the same legacy waiter for symmetry even though
   * no production route awaits it.
   */
  terminalResult: ReviewResult | null;
  /**
   * Milliseconds to add to this session's recorded activity time before
   * gcSilentAgentSessions compares it against AGENT_SILENT_TIMEOUT_MS. Set
   * once by restoreState, to the server's downtime (`now - savedAt`), for a
   * session that survived a restart; 0 for one created after boot, where the
   * shift would have no correct meaning. Shifting rather than resetting to
   * `now` means the outage itself never counts against the session, but
   * whatever idling had already happened before the crash still does: a
   * session already 3 minutes silent when the server went down only gets the
   * 2 minutes it had left after restore, not a fresh 5 (#116 follow-up).
   */
  livenessShiftMs: number;
}

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
  origin?: SessionOrigin; // defaults to 'user'
  clientId?: string;
}

/**
 * The JSON-safe form of a session for the on-disk snapshot (#116): dates are
 * ISO strings and the queued-batch map is a [path, count][] array, since
 * neither Date nor Map survives JSON.stringify/parse. Every field a route or
 * tab can observe on a session is here (see the "Saved" table in the
 * session-persistence design doc), plus terminalResult, which a plain
 * ReviewSession never exposes.
 */
export interface PersistedSession {
  id: string;
  filePaths: string[];
  originalFilePaths: string[];
  fileAddedAt?: Record<string, string>;
  enableResolve: boolean;
  origin: SessionOrigin;
  clientId?: string;
  author?: string;
  createdAt: string;
  /**
   * ISO timestamp, saved so a restart can tell how stale a session already
   * was rather than treating every open session as freshly seen (#116
   * follow-up). See restoreState for how it is used on the way back in.
   */
  lastHeartbeatAt: string;
  lastAgentActivityAt: string | null;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
  waitingForAgentSince: string | null;
  agentCommentCount: number;
  sessionDoneAt: string | null;
  terminalReason: SessionTerminalReason;
  terminalAt: string | null;
  terminalResult: ReviewResult | null;
  queuedBatch: { commentIds: string[]; commentCountsByPath: [string, number][] } | null;
  /**
   * Downtime credit the silent-agent clock already carries from earlier
   * restarts. Saved so a second crash adds to it instead of dropping it,
   * which would count the first outage as silence. Optional: files written
   * before it existed restore with none.
   */
  livenessShiftMs?: number;
}

/**
 * Everything session-persistence.ts writes to and reads from disk. Produced
 * by exportState() and consumed by restoreState(); the file on disk wraps
 * this with a version number and a savedAt timestamp that this module does
 * not need to know about.
 */
export interface PersistedStoreState {
  sessions: PersistedSession[];
  pendingAsks: PendingAsk[];
  settledAsks: { askId: string; sessionId: string; result: AskResult; at: number }[];
}

export class ReviewSessionStore {
  private sessions = new Map<string, InternalSession>();
  private pendingAsks = new Map<string, InternalPendingAsk>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private onSessionAborted: ((sessionId: string, asks: PendingAsk[]) => void) | null = null;
  private onAsksClosedOnDone: ((sessionId: string, asks: PendingAsk[]) => void) | null = null;
  /** Notified after every method that changes state exportState() would save. */
  private onChange: (() => void) | null = null;

  setOnSessionAborted(cb: (sessionId: string, asks: PendingAsk[]) => void): void {
    this.onSessionAborted = cb;
  }

  /**
   * Called after every method that changes state exportState() would save,
   * so the server can debounce a write to disk (#116). Deliberately NOT
   * called from heartbeat() (its clock is reset to the restart moment on
   * load anyway, so persisting it would be pointless) or from
   * beginWaitPark/endWaitPark (parkedWaitCount is never saved; it is always
   * 0 immediately after a restart, since nobody can be parked on a promise
   * that does not exist yet).
   */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
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
      originalFilePaths: [...input.filePaths],
      enableResolve: input.enableResolve,
      origin: input.origin ?? 'user',
      clientId: input.clientId,
      createdAt: now,
      lastHeartbeatAt: now,
      status: 'open',
      sentCommentIds: [],
      waitingForAgent: false,
      resolver,
      waiter,
      parkedWaitCount: 0,
      terminalAt: null,
      waitingForAgentSince: null,
      queuedBatch: null,
      agentCommentCount: 0,
      lastAgentActivityAt: null,
      sessionDoneAt: null,
      terminalReason: null,
      doneResolver: null,
      doneWaiter: null,
      terminalResult: null,
      livenessShiftMs: 0,
    };

    this.sessions.set(id, session);
    this.onChange?.();
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
   * (order-independent), either as they are now or as the session was created
   * before any addFiles (#117). Used to deduplicate when the tool is called
   * twice for the same files. Requires a recent heartbeat so a crash-leaked
   * session doesn't get reused — see FIND_OPEN_FRESHNESS_MS.
   *
   * The `origin` filter is mandatory: agent-origin and user-origin sessions
   * have divergent terminal-state semantics (setSessionDone vs finish/abort),
   * so reusing a user-origin session for an agent request would deadlock the
   * agent's mdr_wait poll when the user clicks Finish or Cancel (those paths
   * never resolve `doneResolver`). Filter callers to match-on-origin.
   */
  findOpenSession(
    filePaths: string[],
    origin: SessionOrigin,
    clientId?: string,
  ): ReviewSession | undefined {
    const freshCutoff = Date.now() - FIND_OPEN_FRESHNESS_MS;
    const requested = [...new Set(filePaths)].sort();
    const sameSet = (paths: string[]) => {
      const sorted = [...new Set(paths)].sort();
      return sorted.length === requested.length && sorted.every((p, i) => p === requested[i]);
    };
    for (const s of this.sessions.values()) {
      if (s.status !== 'open') continue;
      if (s.origin !== origin) continue;
      // Dedupe only within the same caller identity. Distinct agents (each
      // MCP server process sends its own clientId) must not merge into one
      // session: the banner would name only one of them, the single ask
      // slot would serialize them, and one Done would resolve both waits.
      if ((s.clientId ?? null) !== (clientId ?? null)) continue;
      if (s.lastHeartbeatAt.getTime() < freshCutoff) continue;
      // Matching the original files too closes #117's trap: once a session
      // has grown, asking again for the files it started with would otherwise
      // silently open a second review on them. A larger session is never
      // reused for a smaller request that it did not start as.
      if (sameSet(s.filePaths) || sameSet(s.originalFilePaths)) return this.toPublic(s);
    }
    return undefined;
  }

  /**
   * Widen an open session with more files (#117). Paths must already be
   * canonical and access-checked, which the route does. Returns the paths
   * actually added, in request order, skipping any the session already
   * covers; undefined when the session is unknown or no longer open.
   */
  addFiles(
    sessionId: string,
    filePaths: string[],
    maxFiles = Infinity,
  ): { session: ReviewSession; added: string[] } | 'too_many' | undefined {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'open') return undefined;
    const added: string[] = [];
    for (const p of filePaths) {
      if (!s.filePaths.includes(p) && !added.includes(p)) added.push(p);
    }
    // Checked here, on the live list, so two concurrent adds can't both pass.
    if (s.filePaths.length + added.length > maxFiles) return 'too_many';
    s.filePaths.push(...added);
    if (added.length > 0) {
      const at = new Date().toISOString();
      s.fileAddedAt = { ...s.fileAddedAt };
      for (const p of added) s.fileAddedAt[p] = at;
    }
    this.onChange?.();
    return { session: this.toPublic(s), added };
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
      this.onChange?.();
      return resolvedWaiter;
    }

    this.onChange?.();
    return s.waiter;
  }

  /**
   * Bracket around awaiting the /wait waiter, maintained by the HTTP layer.
   * The store cannot observe whether anyone is awaiting a promise, so the
   * route reports it: beginWaitPark just before awaiting, endWaitPark when
   * the request stops listening (response sent, ?timeout elapsed, or the
   * connection aborted). sendBatch consults the count to decide between
   * direct delivery and queueing.
   */
  beginWaitPark(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.parkedWaitCount++;
  }

  endWaitPark(id: string): void {
    const s = this.sessions.get(id);
    if (s && s.parkedWaitCount > 0) s.parkedWaitCount--;
  }

  hasParkedWaiter(id: string): boolean {
    return (this.sessions.get(id)?.parkedWaitCount ?? 0) > 0;
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
    const result: ReviewResult = { status: 'done' };
    s.terminalResult = result;
    s.resolver(result);
    // Remember the id and the precise reason past terminal retention so a
    // late mdr_wait poll still gets the right status after the session is
    // GC'd.
    this.rememberDoneSession(id, 'done');
    // Intentionally NOT firing onSessionAborted — see comment above. The
    // user's choice to click Done while questions were pending is a
    // deliberate "I'm done" signal, not an abort. Preserve markers.
    this.onChange?.();
  }

  /**
   * Bounded log of recently-completed session IDs and their terminal reason.
   * Used by `wasSessionDone` / `getTerminalReason` so a late `mdr_wait` poll
   * after TERMINAL_RETENTION_MS still resolves correctly (with the right
   * reason — not a blanket 'done') even after the session is GC'd from the
   * live map. Cap and FIFO eviction keep memory bounded over a long-lived
   * server.
   */
  private recentlyDoneIds = new Map<string, NonNullable<InternalSession['terminalReason']>>();
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

  /**
   * Deliver a batch to a parked /wait poll. Returns false when direct
   * delivery is impossible — session closed, agent still busy with the
   * previous batch (waitingForAgent), or no poll currently parked — and the
   * caller must queueBatch instead. Delivering with no parked waiter would
   * resolve a promise nobody holds; the batch would be silently lost (see
   * parkedWaitCount).
   */
  sendBatch(id: string, prompt: string, commentIds: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open' || s.waitingForAgent || s.parkedWaitCount === 0) return false;

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

    this.onChange?.();
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
  queueBatch(id: string, commentIds: string[], commentCountsByPath: Map<string, number>): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    // Update sentCommentIds so the UI correctly disables the button after queuing.
    for (const cid of commentIds) {
      if (!s.sentCommentIds.includes(cid)) s.sentCommentIds.push(cid);
    }
    if (s.queuedBatch) {
      const mergedIds = Array.from(new Set([...s.queuedBatch.commentIds, ...commentIds]));
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
    this.onChange?.();
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
    return !!s?.queuedBatch;
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
    // The POST /finish route resolves pending asks BEFORE calling this method
    // (inline-reply delivery, then done_without_reply closure with markers
    // preserved), so via HTTP this path finds nothing. It still runs for
    // programmatic in-process callers (tests, internal helpers) so stranded
    // `agentInitiated` markers don't sit in the file — same behavior as
    // abort() / setSessionDone.
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
    const result: ReviewResult = prompt ? { status: 'done', prompt } : { status: 'done' };
    s.terminalResult = result;
    s.resolver(result);
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
    this.onChange?.();
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
    const result: ReviewResult = { status: 'aborted', reason };
    s.terminalResult = result;
    s.resolver(result);
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
    this.onChange?.();
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
      throw new Error('addAsk requires the agent to have posted at least one comment first');
    }
    for (const ask of this.pendingAsks.values()) {
      if (ask.sessionId === sessionId) {
        throw new Error('a previous mdr_ask is still pending; receive its reply first');
      }
    }
    const askId = `ask_${randomUUID()}`;
    let settle!: (result: AskResult) => void;
    const waiter = new Promise<AskResult>((resolve) => {
      settle = resolve;
    });
    // Every way an ask ends (reply, release, session abort) goes through this
    // resolver, so the result is kept here for a poll that arrives after it.
    const resolver = (result: AskResult) => {
      this.rememberSettledAsk(askId, sessionId, result);
      settle(result);
    };
    this.pendingAsks.set(askId, {
      askId,
      sessionId,
      questions: [...questions],
      resolver,
      waiter,
    });
    this.onChange?.();
    return { askId, waiter };
  }

  /**
   * Final results of recent asks, kept after they leave pendingAsks. The agent
   * long-polls with a timeout and re-polls (#131), so a reply can land while no
   * request is parked; without this, the next poll would get "Ask not found"
   * and the reply would be lost. A result holds the reply text, so it is kept
   * only TERMINAL_RETENTION_MS (the agent re-polls within 90s) and the map is
   * capped, and dispose() clears it.
   */
  private settledAsks = new Map<string, { sessionId: string; result: AskResult; at: number }>();
  private static SETTLED_ASKS_CAP = 200;
  private rememberSettledAsk(askId: string, sessionId: string, result: AskResult): void {
    if (this.settledAsks.size >= ReviewSessionStore.SETTLED_ASKS_CAP) {
      const oldest = this.settledAsks.keys().next().value;
      if (oldest !== undefined) this.settledAsks.delete(oldest);
    }
    this.settledAsks.set(askId, { sessionId, result, at: Date.now() });
  }

  /** The ask's final result if it ended within TERMINAL_RETENTION_MS, scoped to its session. */
  getSettledAsk(sessionId: string, askId: string): AskResult | undefined {
    const settled = this.settledAsks.get(askId);
    if (!settled) return undefined;
    if (Date.now() - settled.at > TERMINAL_RETENTION_MS) {
      this.settledAsks.delete(askId);
      return undefined;
    }
    return settled.sessionId === sessionId ? settled.result : undefined;
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
    this.onChange?.();
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
    this.onChange?.();
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
    // Real activity starts the silence clock over, so any downtime credit
    // from a restart no longer applies.
    s.livenessShiftMs = 0;
    // Treat an agent POST as a heartbeat so subsequent batched calls keep
    // finding this session via findOpenSession even if the browser tab is
    // backgrounded and Chrome throttles its setInterval-based heartbeats.
    //
    // Agent-origin ONLY. That dedupe is an agent-origin concern, and
    // user-origin sessions have no second disconnect detector to fall back on:
    // gcSilentAgentSessions skips them outright, so sweepStale's heartbeat
    // timeout is the sole path to browser_disconnected. Refreshing it here
    // would let an agent replying in-thread hold a closed tab's session open
    // for as long as it keeps posting, and the user's mdr_request_review poll
    // would never learn the review is dead.
    if (s.origin === 'agent') s.lastHeartbeatAt = now;
    this.onChange?.();
  }

  /**
   * Name the session after the agent, from a batch that succeeded. The first
   * name wins, so one stray batch under another name cannot relabel a session
   * mid-review. 'Agent' is the markers' own fallback rather than a name, so it
   * never claims the session and a real name can still arrive later.
   */
  recordAgentAuthor(sessionId: string, author: string | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.author || !author) return;
    const name = author.trim().slice(0, MAX_SESSION_AUTHOR_LEN);
    if (!name || name === 'Agent') return;
    s.author = name;
    this.onChange?.();
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
    this.onChange?.();
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
      // Shifted forward by livenessShiftMs (0 outside of a restored
      // session), so the server's downtime is invisible to the silence
      // timer without erasing whatever idling had already happened before
      // the crash. See livenessShiftMs's own doc comment on InternalSession.
      const effectiveActivity = lastActivity + s.livenessShiftMs;
      if (now - effectiveActivity < AGENT_SILENT_TIMEOUT_MS) continue;
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
    for (const [askId, settled] of this.settledAsks) {
      if (now - settled.at > TERMINAL_RETENTION_MS) this.settledAsks.delete(askId);
    }
    const heartbeatCutoff = now - HEARTBEAT_TIMEOUT_MS;
    const retentionCutoff = now - TERMINAL_RETENTION_MS;
    const agentTimeoutCutoff = now - WAITING_FOR_AGENT_TIMEOUT_MS;
    for (const [id, s] of this.sessions.entries()) {
      if (s.status === 'open') {
        if (s.lastHeartbeatAt.getTime() < heartbeatCutoff) {
          const aborted = this.abortAsks(id, 'browser_disconnected');
          s.status = 'aborted';
          s.terminalAt = new Date(now);
          const result: ReviewResult = { status: 'aborted', reason: 'browser_disconnected' };
          s.terminalResult = result;
          s.resolver(result);
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
          this.onChange?.();
        } else if (
          s.waitingForAgent &&
          s.waitingForAgentSince &&
          s.waitingForAgentSince.getTime() < agentTimeoutCutoff
        ) {
          // Agent didn't call mdr_continue_review in time. Unblock the
          // user so they can send another batch or finish the review.
          s.waitingForAgent = false;
          s.waitingForAgentSince = null;
          this.onChange?.();
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
    this.settledAsks.clear();
  }

  /**
   * A JSON-safe snapshot of everything the spec's "Saved" table calls out
   * (#116): sessions, pending asks, and recent settled-ask results. Pure:
   * no I/O, no clock reads beyond what each session already recorded, so
   * session-persistence.ts can call it on whatever cadence it likes and the
   * store never has to know a file exists.
   *
   * Deliberately excluded, per the design doc's "not saved, rebuilt on
   * load" list: resolver/waiter/doneResolver/doneWaiter (promises don't
   * survive JSON anyway) and parkedWaitCount (always 0 on a fresh process).
   * lastHeartbeatAt IS saved (below): restoreState needs it to tell how
   * stale a session already was, rather than treating every open session as
   * freshly seen (#116 follow-up). recentlyDoneIds is also left out: it
   * exists only to answer a late mdr_wait after in-memory GC, which
   * restoreState already handles by keeping terminal sessions for
   * TERMINAL_RETENTION_MS.
   */
  exportState(): PersistedStoreState {
    const sessions: PersistedSession[] = [];
    for (const s of this.sessions.values()) {
      sessions.push({
        id: s.id,
        filePaths: [...s.filePaths],
        originalFilePaths: [...s.originalFilePaths],
        fileAddedAt: s.fileAddedAt ? { ...s.fileAddedAt } : undefined,
        enableResolve: s.enableResolve,
        origin: s.origin,
        clientId: s.clientId,
        author: s.author,
        createdAt: s.createdAt.toISOString(),
        lastHeartbeatAt: s.lastHeartbeatAt.toISOString(),
        lastAgentActivityAt: s.lastAgentActivityAt ? s.lastAgentActivityAt.toISOString() : null,
        status: s.status,
        sentCommentIds: [...s.sentCommentIds],
        waitingForAgent: s.waitingForAgent,
        waitingForAgentSince: s.waitingForAgentSince ? s.waitingForAgentSince.toISOString() : null,
        agentCommentCount: s.agentCommentCount,
        livenessShiftMs: s.livenessShiftMs,
        sessionDoneAt: s.sessionDoneAt ? s.sessionDoneAt.toISOString() : null,
        terminalReason: s.terminalReason,
        terminalAt: s.terminalAt ? s.terminalAt.toISOString() : null,
        terminalResult: s.terminalResult,
        queuedBatch: s.queuedBatch
          ? {
              commentIds: [...s.queuedBatch.commentIds],
              commentCountsByPath: [...s.queuedBatch.commentCountsByPath.entries()],
            }
          : null,
      });
    }

    const pendingAsks: PendingAsk[] = [];
    for (const ask of this.pendingAsks.values()) {
      pendingAsks.push({
        askId: ask.askId,
        sessionId: ask.sessionId,
        questions: [...ask.questions],
      });
    }

    const settledAsks: PersistedStoreState['settledAsks'] = [];
    for (const [askId, settled] of this.settledAsks) {
      settledAsks.push({
        askId,
        sessionId: settled.sessionId,
        result: settled.result,
        at: settled.at,
      });
    }

    return { sessions, pendingAsks, settledAsks };
  }

  /**
   * Rebuild this store's state from a snapshot exportState() produced
   * elsewhere, after a round trip through JSON (#116). Only meaningful on a
   * store that has never held a session: the server calls this once, after
   * it starts listening but before any request is allowed to run (every
   * request is held open until the restore finishes, via
   * holdRequestsUntilOpen in session-persistence.ts), so nothing else can
   * observe a half-restored store.
   *
   * `now` stands in for the restart moment and `savedAt` for the file's own
   * saved-at timestamp (both parameters, not Date.now() and the file's value
   * read directly, so tests can pick them). Every session's heartbeat clock,
   * and the silence clock gcSilentAgentSessions checks it against, are
   * shifted forward by `now - savedAt` (the server's downtime) rather than
   * reset to `now`: the outage itself must never count against a live tab or
   * agent, but whatever idling had already happened before the crash must
   * still count against the budget it already used. Any session whose
   * terminal state is older than TERMINAL_RETENTION_MS is dropped rather
   * than restored, so a long-dead session doesn't reappear as if it just
   * ended. Never touches a markdown file and never fires onSessionAborted /
   * onAsksClosedOnDone: those callbacks exist to keep a file's markers in
   * sync with a session ending just now, and nothing ended just now here.
   */
  restoreState(state: PersistedStoreState, opts: { now: Date; savedAt: number }): void {
    if (this.sessions.size > 0 || this.pendingAsks.size > 0) {
      throw new Error('restoreState must be called on a store that has not created a session yet');
    }
    const { now, savedAt } = opts;
    // Floored at 0: loadPersistedState already rejects a savedAt in the
    // future before this ever runs, so a negative value here would only mean
    // a caller passed inconsistent now/savedAt values directly (as a test
    // might), not a real clock skew case this needs to handle gracefully.
    const downtimeMs = Math.max(0, now.getTime() - savedAt);

    const retentionCutoff = now.getTime() - TERMINAL_RETENTION_MS;
    for (const persisted of state.sessions) {
      if (
        persisted.status !== 'open' &&
        persisted.terminalAt &&
        Date.parse(persisted.terminalAt) < retentionCutoff
      ) {
        continue; // too old to still matter; nobody can still be polling for it
      }

      let resolver!: (result: ReviewResult) => void;
      const waiter = new Promise<ReviewResult>((resolve) => {
        resolver = resolve;
      });
      if (persisted.status !== 'open' && persisted.terminalResult) {
        // Resolve immediately: an agent whose /wait poll reconnects after
        // the restart must see the same terminal result it would have
        // gotten without one (this is the whole point of #116).
        resolver(persisted.terminalResult);
      }

      // sessionDoneAt is only ever set on agent-origin sessions (via
      // setSessionDone, or the finish/abort/sweep paths through
      // markDoneWaiterResolved), so this one check covers both "terminal
      // agent-origin session" and "session with sessionDoneAt" from the
      // design doc's restore rules.
      const doneWaiter: Promise<void> | null = persisted.sessionDoneAt ? Promise.resolve() : null;

      const session: InternalSession = {
        id: persisted.id,
        filePaths: [...persisted.filePaths],
        originalFilePaths: [...persisted.originalFilePaths],
        fileAddedAt: persisted.fileAddedAt ? { ...persisted.fileAddedAt } : undefined,
        enableResolve: persisted.enableResolve,
        origin: persisted.origin,
        clientId: persisted.clientId,
        author: persisted.author,
        createdAt: new Date(persisted.createdAt),
        // Shifted forward by the downtime rather than reset to `now`: a
        // heartbeat that was already 20 minutes old when the server saved
        // its state must still read as 20 minutes old after restore, not as
        // freshly seen. Resetting to `now` (the old behavior) revived
        // sessions whose tab was already gone before the restart, reopening
        // findOpenSession's dedupe pool and the 30-minute heartbeat sweep
        // window as if the tab had just been seen (#116 follow-up).
        lastHeartbeatAt: new Date(Date.parse(persisted.lastHeartbeatAt) + downtimeMs),
        lastAgentActivityAt: persisted.lastAgentActivityAt
          ? new Date(persisted.lastAgentActivityAt)
          : null,
        status: persisted.status,
        sentCommentIds: [...persisted.sentCommentIds],
        waitingForAgent: persisted.waitingForAgent,
        // Shifted like lastHeartbeatAt: the agent's 60 seconds to pick up a
        // sent batch cannot run while the server is down, or the banner
        // stops showing the agent at work before it could re-poll.
        waitingForAgentSince: persisted.waitingForAgentSince
          ? new Date(Date.parse(persisted.waitingForAgentSince) + downtimeMs)
          : null,
        resolver,
        waiter,
        // Nobody can be parked on a promise that was just recreated.
        parkedWaitCount: 0,
        terminalAt: persisted.terminalAt ? new Date(persisted.terminalAt) : null,
        queuedBatch: persisted.queuedBatch
          ? {
              commentIds: [...persisted.queuedBatch.commentIds],
              commentCountsByPath: new Map(persisted.queuedBatch.commentCountsByPath),
            }
          : null,
        agentCommentCount: persisted.agentCommentCount,
        sessionDoneAt: persisted.sessionDoneAt ? new Date(persisted.sessionDoneAt) : null,
        terminalReason: persisted.terminalReason,
        doneResolver: null,
        doneWaiter,
        terminalResult: persisted.terminalResult,
        livenessShiftMs:
          (Number.isFinite(persisted.livenessShiftMs) ? (persisted.livenessShiftMs as number) : 0) +
          downtimeMs,
      };

      this.sessions.set(session.id, session);
    }

    for (const ask of state.pendingAsks) {
      const session = this.sessions.get(ask.sessionId);
      // A session that didn't survive restore (dropped above, or never
      // existed) or that already ended can't still be waiting on a reply.
      if (!session || session.status !== 'open') continue;
      let settle!: (result: AskResult) => void;
      const waiter = new Promise<AskResult>((resolve) => {
        settle = resolve;
      });
      // Mirrors addAsk's resolver: every way an ask ends still needs to land
      // in settledAsks so a poll that arrives after it is answered.
      const resolver = (result: AskResult) => {
        this.rememberSettledAsk(ask.askId, ask.sessionId, result);
        settle(result);
      };
      this.pendingAsks.set(ask.askId, {
        askId: ask.askId,
        sessionId: ask.sessionId,
        questions: [...ask.questions],
        resolver,
        waiter,
      });
    }

    for (const settled of state.settledAsks) {
      if (now.getTime() - settled.at > TERMINAL_RETENTION_MS) continue;
      this.settledAsks.set(settled.askId, {
        sessionId: settled.sessionId,
        result: settled.result,
        at: settled.at,
      });
    }
  }

  private toPublic(s: InternalSession): ReviewSession {
    return {
      id: s.id,
      filePaths: [...s.filePaths],
      fileAddedAt: s.fileAddedAt ? { ...s.fileAddedAt } : undefined,
      enableResolve: s.enableResolve,
      origin: s.origin,
      clientId: s.clientId,
      createdAt: s.createdAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      lastAgentActivityAt: s.lastAgentActivityAt ? s.lastAgentActivityAt.toISOString() : null,
      author: s.author,
      status: s.status,
      sentCommentIds: [...s.sentCommentIds],
      waitingForAgent: s.waitingForAgent,
    };
  }
}
