import { useCallback, useRef, useEffect } from 'react';

export interface SessionState {
  openTabs: string[];
  activeFilePath: string | null;
}

const STORAGE_KEY = 'md-review-session';
const DEBOUNCE_MS = 500;

export function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Basic shape validation
    if (!Array.isArray(parsed.openTabs)) return null;
    return parsed as SessionState;
  } catch {
    return null;
  }
}

export function useSessionPersistence() {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const persist = useCallback((state: SessionState) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Storage full or unavailable — ignore
      }
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  return { persist };
}
