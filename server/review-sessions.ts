import { randomUUID } from 'crypto';

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
 * creating a new one. 60s is well above the client's 10s heartbeat cadence
 * (so live sessions always pass) and well below HEARTBEAT_TIMEOUT_MS.
 */
const FIND_OPEN_FRESHNESS_MS = 60_000;

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

export type ReviewResult =
  | { status: 'batch'; prompt: string; commentIds: string[] }
  | { status: 'done'; prompt?: string }
  | { status: 'aborted'; reason: 'user_cancelled' | 'browser_disconnected' };

export interface AskQuestion {
  commentId: string;
  filePath: string;
  anchor: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

export type AskResult =
  | { status: 'reply'; replies: Array<{ questionIndex: number; text: string }> }
  | { status: 'aborted'; reason: 'session_cancelled' | 'browser_disconnected' };

export interface PendingAsk {
  askId: string;
  sessionId: string;
  questions: AskQuestion[];
}

interface InternalPendingAsk extends PendingAsk {
  resolver: (result: AskResult) => void;
  waiter: Promise<AskResult>;
}

export interface ReviewSession {
  id: string;
  filePaths: string[];
  enableResolve: boolean;
  createdAt: Date;
  lastHeartbeatAt: Date;
  status: 'open' | 'done' | 'aborted';
  sentCommentIds: string[];
  waitingForAgent: boolean;
}

interface InternalSession extends ReviewSession {
  resolver: (result: ReviewResult) => void;
  waiter: Promise<ReviewResult>;
  /** Set when the session transitions to a terminal state. Used for retention cleanup. */
  terminalAt: Date | null;
  /** When waitingForAgent was last set to true. Used for auto-clear timeout. */
  waitingForAgentSince: Date | null;
  /** Batch queued while waitingForAgent was true. Delivered on the next agent poll. */
  queuedBatch: { prompt: string; commentIds: string[] } | null;
}

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
}

export class ReviewSessionStore {
  private sessions = new Map<string, InternalSession>();
  private pendingAsks = new Map<string, InternalPendingAsk>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private onSessionAborted: ((sessionId: string, asks: PendingAsk[]) => void) | null = null;

  setOnSessionAborted(cb: (sessionId: string, asks: PendingAsk[]) => void): void {
    this.onSessionAborted = cb;
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
   */
  findOpenSession(filePaths: string[]): ReviewSession | undefined {
    const sorted = [...filePaths].sort();
    const freshCutoff = Date.now() - FIND_OPEN_FRESHNESS_MS;
    for (const s of this.sessions.values()) {
      if (s.status !== 'open') continue;
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
   */
  waitForSession(id: string): Promise<ReviewResult> {
    const s = this.sessions.get(id);
    if (!s) {
      throw new Error(`Session not found: ${id}`);
    }
    s.waitingForAgent = false;
    s.waitingForAgentSince = null;

    // If a batch was queued while the agent was busy, deliver it now by
    // resolving the current waiter and returning it before replacing it.
    if (s.queuedBatch) {
      const queued = s.queuedBatch;
      s.queuedBatch = null;
      const resolvedWaiter = s.waiter;
      s.resolver({ status: 'batch', prompt: queued.prompt, commentIds: queued.commentIds });
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
   * mdr_ask). If a batch is already queued, merge with it (concatenate
   * prompts, union of commentIds).
   */
  queueBatch(id: string, prompt: string, commentIds: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    // Update sentCommentIds so the UI correctly disables the button after queuing.
    for (const cid of commentIds) {
      if (!s.sentCommentIds.includes(cid)) s.sentCommentIds.push(cid);
    }
    if (s.queuedBatch) {
      s.queuedBatch = {
        prompt: s.queuedBatch.prompt + '\n\n' + prompt,
        commentIds: Array.from(new Set([...s.queuedBatch.commentIds, ...commentIds])),
      };
    } else {
      s.queuedBatch = { prompt, commentIds: [...commentIds] };
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

  getQueuedBatch(id: string): { prompt: string; commentIds: string[] } | null {
    return this.sessions.get(id)?.queuedBatch ?? null;
  }

  finish(id: string, prompt?: string, commentIds?: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;

    // Defensive: if anyone called finish while asks were pending, abort them.
    this.abortAsks(id, 'session_cancelled');

    if (commentIds) {
      for (const cid of commentIds) {
        if (!s.sentCommentIds.includes(cid)) {
          s.sentCommentIds.push(cid);
        }
      }
    }

    s.status = 'done';
    s.terminalAt = new Date();
    if (prompt) {
      s.resolver({ status: 'done', prompt });
    } else {
      s.resolver({ status: 'done' });
    }
    return true;
  }

  abort(id: string, reason: 'user_cancelled' | 'browser_disconnected'): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    const askReason = reason === 'user_cancelled' ? 'session_cancelled' : 'browser_disconnected';
    const aborted = this.abortAsks(id, askReason);
    s.status = 'aborted';
    s.terminalAt = new Date();
    s.resolver({ status: 'aborted', reason });
    if (aborted.length > 0 && this.onSessionAborted) {
      try {
        this.onSessionAborted(id, aborted);
      } catch {
        /* callback errors are swallowed; cleanup is best-effort */
      }
    }
    return true;
  }

  addAsk(
    sessionId: string,
    questions: AskQuestion[],
  ): { askId: string; waiter: Promise<AskResult> } {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'open') {
      throw new Error('session not found or already finished');
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
    if (ordered.length !== ask.questions.length) return false;
    ask.resolver({ status: 'reply', replies: ordered });
    this.pendingAsks.delete(askId);
    return true;
  }

  abortAsks(sessionId: string, reason: 'session_cancelled' | 'browser_disconnected'): PendingAsk[] {
    const removed: PendingAsk[] = [];
    for (const [id, ask] of this.pendingAsks.entries()) {
      if (ask.sessionId !== sessionId) continue;
      ask.resolver({ status: 'aborted', reason });
      removed.push({ askId: ask.askId, sessionId: ask.sessionId, questions: ask.questions });
      this.pendingAsks.delete(id);
    }
    return removed;
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
    this.sessions.clear();
    this.pendingAsks.clear();
  }

  private toPublic(s: InternalSession): ReviewSession {
    return {
      id: s.id,
      filePaths: [...s.filePaths],
      enableResolve: s.enableResolve,
      createdAt: s.createdAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      status: s.status,
      sentCommentIds: [...s.sentCommentIds],
      waitingForAgent: s.waitingForAgent,
    };
  }
}
