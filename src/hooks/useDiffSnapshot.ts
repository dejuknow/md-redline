import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';

const STORAGE_KEY = 'md-redline-snapshots';

export interface DiffReference {
  content: string;
  capturedAt: number;
  origin: 'handoff' | 'review';
}

/** Normalize stored data, migrating the legacy bare-string format to records. */
function normalizeStored(parsed: unknown): Map<string, DiffReference> {
  const map = new Map<string, DiffReference>();
  if (!parsed || typeof parsed !== 'object') return map;
  for (const [path, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val === 'string') {
      map.set(path, { content: val, capturedAt: Date.now(), origin: 'handoff' });
    } else if (val && typeof val === 'object' && typeof (val as { content?: unknown }).content === 'string') {
      const v = val as { content: string; capturedAt?: unknown; origin?: unknown };
      map.set(path, {
        content: v.content,
        capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : Date.now(),
        origin: v.origin === 'review' ? 'review' : 'handoff',
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

  return {
    currentReference,
    currentSnapshot,
    captureReference,
    restoreReference,
  };
}
