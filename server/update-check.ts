import { homedir } from 'os';
import { isNewerVersion } from '../bin/version-compare.js';
import { readPreferences, writePreferences } from './preferences';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface UpdateCheckerOptions {
  currentVersion: string;
  packageName: string;
  homeDir?: string;
  registryUrl?: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface UpdateChecker {
  /** Seed from the on-disk cache, fetch if stale, then re-check daily. Never throws; never blocks server startup (call without await). Overlapping calls are ignored; a stop() during an in-flight start() prevents the timer from arming. */
  start(): Promise<void>;
  /** Latest published version, or null unless strictly newer than current. */
  getLatest(): string | null;
  /** True until the initial cache/fetch pass settles, and during later fetches. */
  isPending(): boolean;
  stop(): void;
}

/** Ecosystem-standard opt-outs, presence-checked (an empty value counts). */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return 'NO_UPDATE_NOTIFIER' in env || 'CI' in env;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const homeDir = options.homeDir ?? process.env.MD_REDLINE_HOME ?? homedir();
  const registryUrl = (
    options.registryUrl ??
    process.env.MD_REDLINE_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL
  ).replace(/\/+$/, '');
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let latestKnown: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let starting = false;
  let stopped = false;
  let pending = true;

  async function checkOnce(): Promise<void> {
    pending = true;
    try {
      const res = await fetchImpl(`${registryUrl}/-/package/${options.packageName}/dist-tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return;
      const tags: unknown = await res.json();
      const latest = (tags as { latest?: unknown } | null)?.latest;
      if (typeof latest !== 'string') return;
      latestKnown = latest;
      await writePreferences(homeDir, {
        updateCheck: { latestKnown: latest, checkedAt: new Date(now()).toISOString() },
      });
    } catch {
      // Offline, registry down, timeout, unwritable prefs: all silent by
      // design. The next scheduled tick retries.
    } finally {
      pending = false;
    }
  }

  function scheduleNext(delayMs: number): void {
    timer = setTimeout(async () => {
      timer = null;
      await checkOnce();
      if (!stopped) scheduleNext(intervalMs);
    }, delayMs);
    timer.unref?.();
  }

  return {
    async start() {
      if (starting || timer) return;
      starting = true;
      stopped = false;
      pending = true;
      try {
        const cached = (await readPreferences(homeDir)).updateCheck;
        if (cached) latestKnown = cached.latestKnown;
        const checkedAt = Date.parse(cached?.checkedAt ?? '');
        // A future checkedAt (clock skew, hand-edited file) counts as stale.
        const age = now() - checkedAt;
        const fresh = Number.isFinite(checkedAt) && age >= 0 && age < intervalMs;
        if (!fresh) {
          await checkOnce();
        } else {
          pending = false;
        }
        // A stop() issued while the awaits above were in flight wins: the
        // timer must never arm after an explicit stop. For a fresh cache,
        // schedule from its expiry rather than granting a new full interval.
        if (!stopped) {
          scheduleNext(fresh ? intervalMs - age : intervalMs);
        }
      } finally {
        starting = false;
        pending = false;
      }
    },
    getLatest() {
      return latestKnown !== null && isNewerVersion(latestKnown, options.currentVersion)
        ? latestKnown
        : null;
    },
    isPending() {
      return pending;
    },
    stop() {
      stopped = true;
      pending = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
