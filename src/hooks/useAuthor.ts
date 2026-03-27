import { useState, useCallback } from 'react';

const STORAGE_KEY = 'md-redline-author';

// 8 distinct hues for author color coding
const AUTHOR_COLORS = [
  { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' }, // blue
  { bg: '#fce7f3', text: '#9d174d', border: '#f9a8d4' }, // pink
  { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7' }, // green
  { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' }, // amber
  { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' }, // violet
  { bg: '#ffedd5', text: '#9a3412', border: '#fdba74' }, // orange
  { bg: '#cffafe', text: '#155e75', border: '#67e8f9' }, // cyan
  { bg: '#fce4ec', text: '#880e4f', border: '#f48fb1' }, // rose
];

function hashString(str: string): number {
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

  const setAuthor = useCallback((name: string) => {
    const trimmed = name.trim() || 'User';
    setAuthorState(trimmed);
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      // Storage unavailable
    }
  }, []);

  return { author, setAuthor };
}
