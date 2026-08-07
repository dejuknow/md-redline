import { useCallback, useState } from 'react';

/**
 * Session-scoped record of replies that arrived from outside the app — an agent
 * writing to the file, typically — and that the reader has not opened yet.
 *
 * Keyed by file path, because the common shape of a handoff is that the agent
 * answers on a background tab while the reader works elsewhere; each tab has to
 * accumulate its own set to still be able to say "new" when the reader switches
 * to it.
 *
 * Deliberately not persisted. "New since you last looked" is a fact about this
 * session, not about the document, so a reload starting everything as read is
 * the correct behaviour rather than a limitation.
 */
export function useUnreadReplies() {
  const [unreadByPath, setUnreadByPath] = useState<Record<string, string[]>>({});

  const markRepliesUnread = useCallback((filePath: string, replyIds: Iterable<string>) => {
    const incoming = [...replyIds];
    if (incoming.length === 0) return;
    setUnreadByPath((prev) => {
      const next = new Set(prev[filePath] ?? []);
      const sizeBefore = next.size;
      for (const id of incoming) next.add(id);
      if (next.size === sizeBefore) return prev;
      return { ...prev, [filePath]: [...next] };
    });
  }, []);

  const markRepliesRead = useCallback((filePath: string, replyIds: Iterable<string>) => {
    setUnreadByPath((prev) => {
      const current = prev[filePath];
      if (!current || current.length === 0) return prev;
      const read = new Set(replyIds);
      const kept = current.filter((id) => !read.has(id));
      if (kept.length === current.length) return prev;
      return { ...prev, [filePath]: kept };
    });
  }, []);

  return { unreadByPath, markRepliesUnread, markRepliesRead };
}
