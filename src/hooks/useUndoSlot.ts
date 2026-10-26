import { useCallback, useRef, useState } from 'react';

/**
 * Something a toast offered to undo (a delete, a diff reset), kept so Cmd+Z
 * and the palette can still undo it after the toast is gone.
 */
export interface UndoEntry {
  /** What it undoes. Only a comment delete can empty a file's open comments. */
  kind: 'comment-delete' | 'reply-delete' | 'diff-reset';
  /** Finishes the palette's "Undo ..." label: 'delete', 'diff reset'. */
  what: string;
  /** Cmd+Z and the palette offer it only while this file is open. */
  filePath: string | null;
  /**
   * Put things back, or toast why not. It decides when it is used up, by
   * calling `take` with itself, so it can refuse without being lost.
   */
  run: () => void;
  /**
   * Whether nothing has touched what it would restore since. Lets an entry
   * this one set off fold it in, so one undo reverses both (a delete that
   * emptied the open count and so reset the diff).
   */
  isCurrent?: () => boolean;
}

/**
 * One level of undo shared by every action whose toast offers Undo: the most
 * recent one wins, so Cmd+Z always means "what the last Undo button would
 * have done". Undo is per file, as in an editor: while another file is open
 * the entry is left alone, and it is offered again once its file is back.
 */
export function useUndoSlot(activeFilePath: string | null) {
  // The ref is what the handlers read; the state re-renders the palette when
  // an entry appears or goes away. offer and take write both.
  const entryRef = useRef<UndoEntry | null>(null);
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;

  const offer = useCallback((next: UndoEntry) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  /** The entry the slot holds, on any file. */
  const peek = useCallback((): UndoEntry | null => entryRef.current, []);

  /** Whether `e` is still the one to undo: not already undone, not replaced. */
  const holds = useCallback((e: UndoEntry): boolean => entryRef.current === e, []);

  /** Use up `e`. False when the slot no longer holds it: already undone, or replaced. */
  const take = useCallback((e: UndoEntry): boolean => {
    if (entryRef.current !== e) return false;
    entryRef.current = null;
    setEntry(null);
    return true;
  }, []);

  /** Cmd+Z and the palette. False when there is nothing for the open file, so the key can fall through. */
  const undoLast = useCallback((): boolean => {
    const e = entryRef.current;
    if (!e || e.filePath !== activeFilePathRef.current) return false;
    e.run();
    return true;
  }, []);

  const available = entry && entry.filePath === activeFilePath ? entry : null;

  return { available, offer, peek, holds, take, undoLast };
}

export type UndoSlot = ReturnType<typeof useUndoSlot>;
