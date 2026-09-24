import { useEffect, useRef } from 'react';
import type { ReviewSession } from './useReviewSession';

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** When this page loaded, and the review its `?review=` link named, if any. */
const PAGE_LOADED_AT = Date.now();
const PAGE_REVIEW_ID =
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('review');

/**
 * Open the files an agent adds to a review this tab is showing (#117), and say
 * so. A file counts as added when it appears after the tab first saw the
 * session, or, for the review this page's `?review=` link opened, when the
 * server says it was added after the page loaded: that catches a file added in
 * the gap between the link opening the session's files and the first poll that
 * shows the session. Other reviews get no such fallback, since a long-lived
 * tab that only now shows one would open files it never missed. Each file
 * opens at most once per page, so one the reader closed is never reopened,
 * and the files a review started with are left to the `?review=` link.
 */
export function useOpenAddedReviewFiles(
  shownSessions: ReviewSession[],
  openTabInBackground: (path: string) => void,
  notify: (message: string) => void,
  loadedAt: number = PAGE_LOADED_AT,
  loadedReviewId: string | null = PAGE_REVIEW_ID,
): void {
  const knownFiles = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    // Kept for the page's lifetime, never pruned: forgetting a session that
    // drops out of view would make its later return a first sighting, and a
    // file added after load, then closed by the reader, would reopen.
    const known = knownFiles.current;
    for (const session of shownSessions) {
      let seen = known.get(session.id);
      if (!seen) {
        const addedAt = session.id === loadedReviewId ? (session.fileAddedAt ?? {}) : {};
        seen = new Set(
          session.filePaths.filter((p) => !addedAt[p] || Date.parse(addedAt[p]) <= loadedAt),
        );
        known.set(session.id, seen);
      }
      const added = session.filePaths.filter((p) => !seen.has(p));
      if (added.length === 0) continue;
      for (const path of added) {
        seen.add(path);
        openTabInBackground(path);
      }
      notify(`${session.author ?? 'Agent'} added ${added.map(fileName).join(', ')} to this review`);
    }
  }, [shownSessions, openTabInBackground, notify, loadedAt, loadedReviewId]);
}
