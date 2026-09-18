import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiffReference } from './useDiffSnapshot';

export interface BaselineMeta {
  path: string;
  capturedAt: number;
  agentName?: string;
  bytes: number;
}

const POLL_INTERVAL_MS = 5_000;

interface Options {
  /** Every open tab's file path. Only these are ever fetched. */
  openPaths: string[];
  getReference: (path: string) => DiffReference | null;
  /** Newest-wins seed from useDiffSnapshot. Returns whether it landed. */
  seedReference: (path: string, ref: DiffReference) => boolean;
  /** Fired after a seed lands. App uses it for the pending dot. */
  onSeeded?: (path: string, ref: DiffReference) => void;
  enabled?: boolean;
}

function metasEqual(a: BaselineMeta[], b: BaselineMeta[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].capturedAt !== b[i].capturedAt) return false;
  }
  return true;
}

/**
 * Pick up "before" copies an agent saved on the server (via mdr_baseline)
 * and seed the browser's diff reference for open tabs. Polls metadata on
 * the same cadence as review sessions; content is fetched per path only
 * when the server copy is newer than the local reference, and only once
 * per (path, capturedAt) so a seed that lost to a newer local reference
 * is not retried every tick.
 */
export function useAgentBaselines(opts: Options): {
  baselines: BaselineMeta[];
  refresh: () => Promise<void>;
} {
  const { openPaths, getReference, seedReference, onSeeded, enabled = true } = opts;
  const [baselines, setBaselines] = useState<BaselineMeta[]>([]);
  // Bumped after every successful metadata poll, even when the metadata
  // itself is unchanged, so the seed pass below reruns and can retry a
  // content fetch that failed on a previous pass.
  const [pollTick, setPollTick] = useState(0);
  const attempted = useRef(new Set<string>());

  const callbacks = useRef({ getReference, seedReference, onSeeded });
  useEffect(() => {
    callbacks.current = { getReference, seedReference, onSeeded };
  }, [getReference, seedReference, onSeeded]);

  const fetchMetas = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch('/api/baselines', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { baselines: BaselineMeta[] };
      setBaselines((prev) => (metasEqual(prev, data.baselines) ? prev : data.baselines));
      setPollTick((t) => t + 1);
    } catch {
      /* next poll retries */
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void fetchMetas();
    const id = setInterval(() => void fetchMetas(), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchMetas();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, fetchMetas]);

  // Seed pass: whenever metadata, the open set, or a poll tick changes. A
  // fetch that is still in flight when this reruns is not cancelled: the
  // `callbacks` ref always calls the latest seedReference/onSeeded, and
  // seedReference is newest-wins, so a late-resolving fetch is harmless.
  const openKey = openPaths.join('\n');
  useEffect(() => {
    if (!enabled) return;
    const open = new Set(openPaths);
    for (const meta of baselines) {
      if (!open.has(meta.path)) continue;
      const key = `${meta.path}@${meta.capturedAt}`;
      if (attempted.current.has(key)) continue;
      const local = callbacks.current.getReference(meta.path);
      if (local && local.capturedAt >= meta.capturedAt) {
        attempted.current.add(key);
        continue;
      }
      attempted.current.add(key);
      void (async () => {
        try {
          const res = await fetch(`/api/baselines/content?path=${encodeURIComponent(meta.path)}`, {
            cache: 'no-store',
          });
          if (!res.ok) {
            attempted.current.delete(key);
            return;
          }
          const full = (await res.json()) as BaselineMeta & { content: string };
          const ref: DiffReference = {
            content: full.content,
            capturedAt: full.capturedAt,
            origin: 'agent',
            ...(full.agentName ? { agentName: full.agentName } : {}),
          };
          if (callbacks.current.seedReference(meta.path, ref)) {
            callbacks.current.onSeeded?.(meta.path, ref);
          }
        } catch {
          // Release the key so the next poll retries this path.
          attempted.current.delete(key);
        }
      })();
    }
    // openKey stands in for openPaths so a new array with the same members
    // does not re-run the pass; pollTick forces a rerun after every poll so
    // a released key (a failed fetch) gets retried even when the polled
    // metadata itself is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselines, openKey, enabled, pollTick]);

  const refresh = useCallback(() => fetchMetas(), [fetchMetas]);
  return { baselines, refresh };
}
