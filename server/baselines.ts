/**
 * Server-held "before" copies of markdown files an agent is about to edit.
 *
 * The browser's diff overlay compares the file on disk against a per-path
 * reference that, until now, only the reviewer's own clicks could create.
 * An agent calls `mdr_baseline` before editing; the route reads the file
 * from disk and stores it here; the browser seeds its reference from this
 * copy only when it has no reference for that path at all.
 *
 * In-memory store with no I/O of its own. Reading files, checking sizes, and
 * validating paths belong to the route layer; saving copies to disk so they
 * survive a restart (#138) belongs to baseline-persistence.ts, which hears
 * about every stored and dropped copy through `setListener`.
 */

export interface Baseline {
  /** Canonical absolute path (realpath), as the routes resolve it. */
  path: string;
  content: string;
  /**
   * Epoch ms at capture. The store keeps the newest copy per path; the
   * browser only uses a copy to fill a gap.
   */
  capturedAt: number;
  agentName?: string;
  /** UTF-8 byte length of `content`. */
  bytes: number;
}

export type BaselineMeta = Omit<Baseline, 'content'>;

/** Per-file cap. A markdown document past this is not something to diff in a browser. */
export const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
/** Entry cap. Oldest by capturedAt is evicted when a new path arrives at the cap. */
export const MAX_BASELINES = 64;
/** An unclaimed baseline is dropped after this long. Checked lazily on read. */
export const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

/** Told about every copy the store keeps or drops, in the order it happens. */
export interface BaselineListener {
  /** A copy put back by `restore`, already saved; nothing to write. */
  restored(entry: Baseline): void;
  stored(entry: Baseline): void;
  removed(path: string): void;
}

export class BaselineStore {
  private readonly entries = new Map<string, Baseline>();
  private readonly now: () => number;
  private listener: BaselineListener | null = null;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  setListener(listener: BaselineListener | null): void {
    this.listener = listener;
  }

  /**
   * Put back copies saved before a restart, keeping their original capture
   * times so the 24h expiry still counts from the real capture. Past the
   * expiry or the entry cap, the oldest are dropped, and the listener hears
   * about each one so its saved file goes too. Expects one copy per path and
   * an empty store, so call it before anything else writes.
   */
  restore(saved: Baseline[]): void {
    const newestFirst = [...saved].sort((a, b) => b.capturedAt - a.capturedAt);
    for (const entry of newestFirst) {
      this.listener?.restored(entry);
      if (this.entries.size >= MAX_BASELINES) this.listener?.removed(entry.path);
      else this.entries.set(entry.path, { ...entry });
    }
    this.expire();
  }

  /** Store a copy for `path`, replacing any older one. Returns metadata only. */
  set(input: { path: string; content: string; agentName?: string }): BaselineMeta {
    this.expire();
    if (!this.entries.has(input.path) && this.entries.size >= MAX_BASELINES) {
      this.evictOldest();
    }
    const entry: Baseline = {
      path: input.path,
      content: input.content,
      capturedAt: this.now(),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    };
    this.entries.set(input.path, entry);
    this.listener?.stored(entry);
    return toMeta(entry);
  }

  /** The full record for `path`, or null when absent or expired. */
  get(path: string): Baseline | null {
    this.expire();
    return this.entries.get(path) ?? null;
  }

  /** Whether a live copy exists for `path`, after the same lazy expiry as `get`. */
  has(path: string): boolean {
    this.expire();
    return this.entries.has(path);
  }

  /** Metadata for every live entry, newest first. Never includes content. */
  list(): BaselineMeta[] {
    this.expire();
    return [...this.entries.values()].sort((a, b) => b.capturedAt - a.capturedAt).map(toMeta);
  }

  private expire(): void {
    const cutoff = this.now() - BASELINE_TTL_MS;
    for (const [path, entry] of this.entries) {
      if (entry.capturedAt < cutoff) this.drop(path);
    }
  }

  private evictOldest(): void {
    let oldest: Baseline | null = null;
    for (const entry of this.entries.values()) {
      if (!oldest || entry.capturedAt < oldest.capturedAt) oldest = entry;
    }
    if (oldest) this.drop(oldest.path);
  }

  private drop(path: string): void {
    this.entries.delete(path);
    this.listener?.removed(path);
  }
}

function toMeta(entry: Baseline): BaselineMeta {
  const meta: BaselineMeta = { path: entry.path, capturedAt: entry.capturedAt, bytes: entry.bytes };
  if (entry.agentName !== undefined) meta.agentName = entry.agentName;
  return meta;
}
