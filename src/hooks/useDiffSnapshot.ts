import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';

const STORAGE_KEY = 'md-redline-snapshots';

export type DiffReferenceOrigin = 'handoff' | 'review' | 'agent';

export interface DiffReference {
  content: string;
  capturedAt: number;
  origin: DiffReferenceOrigin;
  /** Set when origin is 'agent' and the tool call named the agent. */
  agentName?: string;
}

const ORIGINS: ReadonlySet<string> = new Set(['handoff', 'review', 'agent']);

/** Normalize stored data, migrating the legacy bare-string format to records. */
function normalizeStored(parsed: unknown): Map<string, DiffReference> {
  const map = new Map<string, DiffReference>();
  if (!parsed || typeof parsed !== 'object') return map;
  for (const [path, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val === 'string') {
      map.set(path, { content: val, capturedAt: Date.now(), origin: 'handoff' });
    } else if (
      val &&
      typeof val === 'object' &&
      typeof (val as { content?: unknown }).content === 'string'
    ) {
      const v = val as {
        content: string;
        capturedAt?: unknown;
        origin?: unknown;
        agentName?: unknown;
      };
      const origin: DiffReferenceOrigin =
        typeof v.origin === 'string' && ORIGINS.has(v.origin)
          ? (v.origin as DiffReferenceOrigin)
          : 'handoff';
      map.set(path, {
        content: v.content,
        capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : Date.now(),
        origin,
        ...(origin === 'agent' && typeof v.agentName === 'string'
          ? { agentName: v.agentName }
          : {}),
      });
    }
  }
  return map;
}

export function useDiffSnapshot(activeFilePath: string | null, rawMarkdownRef: RefObject<string>) {
  const [refs, setRefs] = useState<Map<string, DiffReference>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      return normalizeStored(JSON.parse(raw));
    } catch {
      return new Map();
    }
  });

  // Mirror of refs for synchronous reads inside imperative callbacks.
  const refsRef = useRef(refs);
  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  useEffect(() => {
    try {
      if (refs.size === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(refs)));
      }
    } catch {
      /* ignore quota errors */
    }
  }, [refs]);

  const currentReference = activeFilePath ? (refs.get(activeFilePath) ?? null) : null;
  const currentSnapshot = currentReference?.content ?? null;

  /**
   * Capture the active file (and any extra handoff files) as a new reference.
   * Returns the PREVIOUS reference for the active file so callers can offer Undo.
   */
  const captureReference = useCallback(
    (origin: 'handoff' | 'review', extraEntries?: Map<string, string>): DiffReference | null => {
      if (!activeFilePath) return null;
      const prev = refsRef.current.get(activeFilePath) ?? null;
      const now = Date.now();
      setRefs((prevMap) => {
        const next = new Map(prevMap);
        next.set(activeFilePath, { content: rawMarkdownRef.current, capturedAt: now, origin });
        if (extraEntries) {
          for (const [path, content] of extraEntries) {
            next.set(path, { content, capturedAt: now, origin: 'handoff' });
          }
        }
        return next;
      });
      return prev;
    },
    [activeFilePath, rawMarkdownRef],
  );

  /** Set the active file's reference to a specific value (used by Undo). */
  const restoreReference = useCallback(
    (ref: DiffReference | null) => {
      if (!activeFilePath) return;
      setRefs((prevMap) => {
        const next = new Map(prevMap);
        if (ref) next.set(activeFilePath, ref);
        else next.delete(activeFilePath);
        return next;
      });
    },
    [activeFilePath],
  );

  /**
   * Accept a reference the browser did not capture itself (an agent's
   * before copy from the server). Newest wins: the seed lands only when the
   * path has no reference or its reference is older. A Mark reviewed or
   * handoff click after the agent's capture is newer and stays put.
   */
  const seedReference = useCallback((path: string, ref: DiffReference): boolean => {
    const existing = refsRef.current.get(path);
    if (existing && existing.capturedAt >= ref.capturedAt) return false;
    const next = new Map(refsRef.current);
    next.set(path, ref);
    refsRef.current = next;
    setRefs((prevMap) => {
      const queued = prevMap.get(path);
      if (queued && queued.capturedAt >= ref.capturedAt) return prevMap;
      const merged = new Map(prevMap);
      merged.set(path, ref);
      return merged;
    });
    return true;
  }, []);

  /** Synchronous read of any path's reference, for callers outside render. */
  const getReference = useCallback(
    (path: string): DiffReference | null => refsRef.current.get(path) ?? null,
    [],
  );

  return {
    currentReference,
    currentSnapshot,
    captureReference,
    restoreReference,
    seedReference,
    getReference,
  };
}
