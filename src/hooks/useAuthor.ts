import { useState, useCallback, useEffect } from 'react';
import { fetchPreferences, savePreferencesToDisk } from '../lib/preferences-client';

const STORAGE_KEY = 'md-redline-author';

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

function loadAuthor(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'User';
  } catch {
    return 'User';
  }
}

export function useAuthor() {
  const [author, setAuthorState] = useState(loadAuthor);

  // Hydrate from disk on mount
  useEffect(() => {
    fetchPreferences().then((prefs) => {
      if (prefs.author && prefs.author !== author) {
        setAuthorState(prefs.author);
        try { localStorage.setItem(STORAGE_KEY, prefs.author); } catch { /* storage unavailable */ }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAuthor = useCallback((name: string) => {
    const trimmed = name.trim() || 'User';
    setAuthorState(trimmed);
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      // Storage unavailable
    }
    savePreferencesToDisk({ author: trimmed });
  }, []);

  return { author, setAuthor };
}
