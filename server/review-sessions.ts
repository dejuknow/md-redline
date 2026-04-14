import { randomUUID } from 'crypto';

const HEARTBEAT_TIMEOUT_MS = 30_000;

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
}

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
}

export class ReviewSessionStore {
  private sessions = new Map<string, InternalSession>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;

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
   * Returns the session's resolution promise. Throws if the session does not
   * exist — callers should check existence first (the HTTP layer already does).
   */
  waitForSession(id: string): Promise<ReviewResult> {
    const s = this.sessions.get(id);
    if (!s) {
      throw new Error(`Session not found: ${id}`);
    }
    s.waitingForAgent = false;
    s.waitingForAgentSince = null;
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

  finish(id: string, prompt?: string, commentIds?: string[]): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;

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
    s.status = 'aborted';
    s.terminalAt = new Date();
    s.resolver({ status: 'aborted', reason });
    return true;
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
          s.status = 'aborted';
          s.terminalAt = new Date(now);
          s.resolver({ status: 'aborted', reason: 'browser_disconnected' });
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
    this.sessions.clear();
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
