import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

const DEFAULT_AUTHOR = 'User';

// 8 maximally distinct hues for author color coding
const AUTHOR_COLORS = [
  { bg: '#dbeafe', text: '#2563eb', border: '#93c5fd' }, // blue
  { bg: '#fce7f3', text: '#db2777', border: '#f9a8d4' }, // pink
  { bg: '#d1fae5', text: '#059669', border: '#6ee7b7' }, // green
  { bg: '#fef3c7', text: '#d97706', border: '#fcd34d' }, // amber
  { bg: '#ede9fe', text: '#7c3aed', border: '#c4b5fd' }, // violet
  { bg: '#ffedd5', text: '#ea580c', border: '#fdba74' }, // orange
  { bg: '#cffafe', text: '#0891b2', border: '#67e8f9' }, // cyan
  { bg: '#fce4ec', text: '#e11d48', border: '#f48fb1' }, // rose
];

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getAuthorColor(author: string) {
  return AUTHOR_COLORS[hashString(author) % AUTHOR_COLORS.length];
}

export function useAuthor() {
  const [author, setAuthorState] = useState(DEFAULT_AUTHOR);
  const hasLocalMutationRef = useRef(false);

  // Hydrate from disk on mount. Disk is the source of truth.
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled || hasLocalMutationRef.current) return;
      if (typeof prefs.author === 'string' && prefs.author.trim()) {
        setAuthorState(prefs.author);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setAuthor = useCallback((name: string) => {
    const trimmed = name.trim() || DEFAULT_AUTHOR;
    hasLocalMutationRef.current = true;
    setAuthorState(trimmed);
    void savePreferencesToDisk({ author: trimmed });
  }, []);

  return { author, setAuthor };
}
