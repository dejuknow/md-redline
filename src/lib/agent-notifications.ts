// Desktop notifications for agent activity that needs the reader (#244).
// Pure: detection, batching, dedupe and wording. The hook in
// src/hooks/useAgentNotifications.ts feeds it, and the desktop shell takes
// what it produces through window.__mdrTakeAgentNotifications.

import type { CommentReply, MdComment } from '../types';

/** Where a click on a notification takes the reader. */
export type NotificationTarget = { file: string; commentId?: string } | { review: string };

/** A reply or a question that arrived in one thread of one file. */
export interface ThreadEvent {
  kind: 'reply' | 'question';
  /** Dedupe key: `r:<reply id>` or `q:<comment id>`. */
  key: string;
  filePath: string;
  commentId: string;
  author: string;
  text: string;
}

/** An agent finished a round of work on a review and handed it back. */
export interface RoundEvent {
  kind: 'round';
  /** Dedupe key: `f:<session id>:<round>`. */
  key: string;
  sessionId: string;
  origin: 'user' | 'agent';
  filePaths: string[];
  author: string;
}

export type AgentEvent = ThreadEvent | RoundEvent;

/** One notification, as the shell posts it. */
export interface DesktopNotification {
  /** Unique per notification: the first event's key. */
  id: string;
  title: string;
  body: string;
  /** Notifications with the same group stack together: a file or a review. */
  group: string;
  target: NotificationTarget;
}

/** What the shell gets back from __mdrTakeAgentNotifications. */
export interface TakeResult {
  enabled: boolean;
  items: DesktopNotification[];
}

const FALLBACK_AUTHOR = 'Agent';
/** Longest body text kept; macOS shows about two lines anyway. */
const BODY_MAX = 160;
/** A flush with more notifications than this becomes one summary. */
const MAX_PER_FLUSH = 3;

/**
 * Whether an arriving reply is an agent's. mdr stamps `agent` on every reply
 * it writes (#102): false from the reader's own UI, true from the agent API.
 * An unstamped reply arrived by an edit to the file, which is how an agent
 * following the review prompt replies (backfillReplyTimestamps stamps it
 * `agent: true`), unless it carries the reader's own name: then the reader
 * wrote it in another editor.
 */
export function isAgentReply(reply: CommentReply, readerName: string): boolean {
  if (reply.agent === true) return true;
  if (reply.agent === false) return false;
  return (reply.author ?? '').trim() !== readerName.trim();
}

/**
 * The agent replies and questions that are new in `newComments`. Only a
 * comparison against content the tab already had counts: the caller must not
 * pass a tab's first load, or the file's whole history would look new.
 */
export function detectThreadEvents(
  filePath: string,
  oldComments: readonly MdComment[],
  newComments: readonly MdComment[],
  readerName: string,
): ThreadEvent[] {
  const oldById = new Map(oldComments.map((c) => [c.id, c]));
  const events: ThreadEvent[] = [];
  for (const comment of newComments) {
    const old = oldById.get(comment.id);
    if (!old && comment.agentInitiated === true && comment.expectsReply === true) {
      events.push({
        kind: 'question',
        key: `q:${comment.id}`,
        filePath,
        commentId: comment.id,
        author: comment.author || FALLBACK_AUTHOR,
        text: comment.text,
      });
    }
    const oldReplyIds = new Set((old?.replies ?? []).map((r) => r.id));
    for (const reply of comment.replies ?? []) {
      if (oldReplyIds.has(reply.id) || !isAgentReply(reply, readerName)) continue;
      events.push({
        kind: 'reply',
        key: `r:${reply.id}`,
        filePath,
        commentId: comment.id,
        author: reply.author || FALLBACK_AUTHOR,
        text: reply.text,
      });
    }
  }
  return events;
}

/** The fields of a review session round detection reads. */
export interface RoundSession {
  id: string;
  origin: 'user' | 'agent';
  filePaths: string[];
  author?: string;
  /** Absent from a server older than #244, which never notifies. */
  agentRounds?: number;
}

/** Each session's round count as last seen. */
export interface RoundState {
  /** False until the first sessions list after load has been seen. */
  initialized: boolean;
  rounds: ReadonlyMap<string, number>;
}

export const INITIAL_ROUND_STATE: RoundState = { initialized: false, rounds: new Map() };

/**
 * Rounds that finished since the last sessions list. The first list after a
 * load is only a baseline, so a reload or a restart never repeats a round
 * that ended before it. A session that shows up later starts from zero, so
 * an agent that posts and starts waiting between two polls still counts.
 */
export function detectRoundEvents(
  state: RoundState,
  sessions: readonly RoundSession[],
): { events: RoundEvent[]; state: RoundState } {
  const rounds = new Map<string, number>();
  const events: RoundEvent[] = [];
  for (const session of sessions) {
    const count = session.agentRounds;
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    const seen = state.rounds.get(session.id) ?? 0;
    // A high-water mark: a late answer to an older poll can carry a lower
    // count, and must not make the next one look new.
    rounds.set(session.id, Math.max(count, seen));
    if (!state.initialized) continue;
    if (count > seen) {
      events.push({
        kind: 'round',
        key: `f:${session.id}:${count}`,
        sessionId: session.id,
        origin: session.origin,
        filePaths: [...session.filePaths],
        author: session.author || FALLBACK_AUTHOR,
      });
    }
  }
  return { events, state: { initialized: true, rounds } };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 1).trimEnd()}…` : flat;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function filesLabel(paths: readonly string[]): string {
  const [first, ...rest] = paths;
  if (!first) return '';
  return rest.length === 0 ? baseName(first) : `${baseName(first)} and ${rest.length} more`;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

/**
 * Turns one batch of events into notifications. Questions come first (the
 * agent is blocked on them), one per file; then finished rounds, one per
 * review, each taking in the replies on that review's files so a pass over
 * the reader's comments is one notification; then the remaining replies, one
 * per file. A batch that would still make more than three becomes a single
 * summary pointing at the most urgent one.
 */
export function buildNotifications(events: readonly AgentEvent[]): DesktopNotification[] {
  const questions = events.filter((e): e is ThreadEvent => e.kind === 'question');
  const rounds = events.filter((e): e is RoundEvent => e.kind === 'round');
  let replies = events.filter((e): e is ThreadEvent => e.kind === 'reply');
  const out: DesktopNotification[] = [];

  for (const group of groupBy(questions, (q) => q.filePath)) {
    const first = group[0];
    const file = baseName(first.filePath);
    out.push({
      id: first.key,
      title:
        group.length === 1
          ? `${first.author} has a question on ${file}`
          : `${first.author} has ${group.length} questions on ${file}`,
      body: clip(first.text),
      group: first.filePath,
      target: { file: first.filePath, commentId: first.commentId },
    });
  }

  for (const group of groupBy(rounds, (r) => r.sessionId)) {
    const round = group[group.length - 1];
    const files = new Set(round.filePaths);
    // Only this agent's replies: another agent working on the same file keeps
    // its own notification and its own click target.
    const belongs = (r: ThreadEvent) => files.has(r.filePath) && r.author === round.author;
    const absorbed = replies.filter(belongs);
    replies = replies.filter((r) => !belongs(r));
    const parts = [filesLabel(round.filePaths)];
    if (absorbed.length > 0) parts.push(plural(absorbed.length, 'new reply', 'new replies'));
    out.push({
      id: round.key,
      title:
        round.origin === 'user'
          ? `${round.author} finished working on your comments`
          : `${round.author} finished reviewing`,
      body: parts.filter(Boolean).join(' · '),
      group: `review:${round.sessionId}`,
      target: { review: round.sessionId },
    });
  }

  for (const group of groupBy(replies, (r) => r.filePath)) {
    const first = group[0];
    const file = baseName(first.filePath);
    const threads = new Set(group.map((r) => r.commentId)).size;
    out.push({
      id: first.key,
      title:
        threads === 1
          ? `${first.author} replied on ${file}`
          : `${first.author} replied to ${threads} threads on ${file}`,
      // The text of the thread the click opens.
      body: clip(first.text),
      group: first.filePath,
      target: { file: first.filePath, commentId: first.commentId },
    });
  }

  if (out.length <= MAX_PER_FLUSH) return out;
  const parts: string[] = [];
  if (questions.length > 0) parts.push(plural(questions.length, 'question', 'questions'));
  if (rounds.length > 0) parts.push(plural(rounds.length, 'finished review', 'finished reviews'));
  const replyCount = events.filter((e) => e.kind === 'reply').length;
  if (replyCount > 0) parts.push(plural(replyCount, 'reply', 'replies'));
  return [
    {
      id: out[0].id,
      title: 'Your agents need you',
      body: `${parts.join(', ')}. Click to open the first.`,
      group: 'summary',
      target: out[0].target,
    },
  ];
}

/** Storage the seen keys live in; null when there is none (tests, or blocked). */
export type KeyStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

/**
 * Keys of events that already had their one chance to notify, kept across
 * reloads and restarts (localStorage) so a replayed change never notifies
 * twice. Capped, oldest first out; every storage call is guarded, since
 * storage can be missing or throw.
 */
export class SeenKeys {
  private keys: string[] | null = null;
  private set = new Set<string>();
  private readonly storage: KeyStorage;
  private readonly storageKey: string;
  private readonly cap: number;

  constructor(storage: KeyStorage, storageKey = 'md-redline-agent-notified', cap = 500) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.cap = cap;
  }

  private load(): void {
    if (this.keys) return;
    this.keys = [];
    try {
      const raw = this.storage?.getItem(this.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        this.keys = parsed.filter((k): k is string => typeof k === 'string').slice(-this.cap);
      }
    } catch {
      this.keys = [];
    }
    this.set = new Set(this.keys);
  }

  has(key: string): boolean {
    this.load();
    return this.set.has(key);
  }

  /** Records keys not seen before and saves once. */
  addAll(keys: readonly string[]): void {
    this.load();
    let changed = false;
    for (const key of keys) {
      if (this.set.has(key)) continue;
      this.set.add(key);
      this.keys!.push(key);
      changed = true;
    }
    if (!changed) return;
    if (this.keys!.length > this.cap) {
      const dropped = this.keys!.splice(0, this.keys!.length - this.cap);
      for (const key of dropped) this.set.delete(key);
    }
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.keys));
    } catch {
      // Full or blocked storage: dedupe still holds for this page's life.
    }
  }
}

export interface QueueTiming {
  /** A batch goes out once nothing new has arrived for this long. */
  quietMs: number;
  /** ...or once its oldest event has waited this long, whatever keeps arriving. */
  maxHoldMs: number;
}

export const DEFAULT_QUEUE_TIMING: QueueTiming = { quietMs: 3_000, maxHoldMs: 12_000 };

/**
 * Holds events until a batch is ripe. Timer-free on purpose: the shell's
 * regular take call is the clock, because a hidden page's own timers are
 * throttled. Every event is marked seen when it arrives, whether or not it
 * is queued, so one the reader saw on screen never notifies later.
 */
export class AgentNotificationQueue {
  private pending: AgentEvent[] = [];
  private firstAt = 0;
  private lastAt = 0;
  private readonly seen: SeenKeys;
  private readonly timing: QueueTiming;

  constructor(seen: SeenKeys, timing: QueueTiming = DEFAULT_QUEUE_TIMING) {
    this.seen = seen;
    this.timing = timing;
  }

  /** Queues the events not seen before, unless the reader is looking. */
  add(events: readonly AgentEvent[], now: number, readerPresent: boolean): void {
    const fresh = events.filter(
      (e, i) => !this.seen.has(e.key) && events.findIndex((x) => x.key === e.key) === i,
    );
    if (fresh.length === 0) return;
    this.seen.addAll(fresh.map((e) => e.key));
    if (readerPresent) return;
    if (this.pending.length === 0) this.firstAt = now;
    this.lastAt = now;
    this.pending.push(...fresh);
  }

  /**
   * The ripe batch, or nothing. With the reader back, what is pending is
   * dropped: they are looking at it.
   */
  take(now: number, readerPresent: boolean): AgentEvent[] {
    if (this.pending.length === 0) return [];
    if (readerPresent) {
      this.pending = [];
      return [];
    }
    const ripe =
      now - this.lastAt >= this.timing.quietMs || now - this.firstAt >= this.timing.maxHoldMs;
    if (!ripe) return [];
    const batch = this.pending;
    this.pending = [];
    return batch;
  }

  clear(): void {
    this.pending = [];
  }

  get size(): number {
    return this.pending.length;
  }
}
