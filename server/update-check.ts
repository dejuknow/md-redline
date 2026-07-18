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
  /** Seed from the on-disk cache, fetch if stale, then re-check daily. Never throws; never blocks server startup (call without await). Overlapping calls are ignored; a stop() during an in-flight start() prevents the interval from arming. */
  start(): Promise<void>;
  /** Latest published version, or null unless strictly newer than current. */
  getLatest(): string | null;
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
  let timer: ReturnType<typeof setInterval> | null = null;
  let starting = false;
  let stopped = false;

  async function checkOnce(): Promise<void> {
    try {
      const res = await fetchImpl(
        `${registryUrl}/-/package/${options.packageName}/dist-tags`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
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
    }
  }

  return {
    async start() {
      if (starting || timer) return;
      starting = true;
      stopped = false;
      try {
        const cached = (await readPreferences(homeDir)).updateCheck;
        if (cached) latestKnown = cached.latestKnown;
        const checkedAt = Date.parse(cached?.checkedAt ?? '');
        // A future checkedAt (clock skew, hand-edited file) counts as stale.
        const fresh =
          Number.isFinite(checkedAt) && checkedAt <= now() && now() - checkedAt < intervalMs;
        if (!fresh) await checkOnce();
        // A stop() issued while the awaits above were in flight wins: the
        // interval must never arm after an explicit stop.
        if (!stopped) {
          timer = setInterval(() => void checkOnce(), intervalMs);
          timer.unref?.();
        }
      } finally {
        starting = false;
      }
    },
    getLatest() {
      return latestKnown !== null && isNewerVersion(latestKnown, options.currentVersion)
        ? latestKnown
        : null;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
