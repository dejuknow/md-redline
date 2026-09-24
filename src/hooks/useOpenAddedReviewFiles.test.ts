// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOpenAddedReviewFiles } from './useOpenAddedReviewFiles';
import type { ReviewSession } from './useReviewSession';

function session(filePaths: string[], overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'rev_1',
    filePaths,
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'user',
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

const LOADED_AT = Date.parse('2026-09-24T12:00:00Z');

function setup(initial: ReviewSession[]) {
  const openTab = vi.fn();
  const notify = vi.fn();
  const hook = renderHook(
    ({ sessions }) => useOpenAddedReviewFiles(sessions, openTab, notify, LOADED_AT, 'rev_1'),
    { initialProps: { sessions: initial } },
  );
  return { openTab, notify, rerender: (sessions: ReviewSession[]) => hook.rerender({ sessions }) };
}

describe('useOpenAddedReviewFiles (#117)', () => {
  it('leaves the files a review started with alone', () => {
    const { openTab, notify } = setup([session(['/d/a.md', '/d/b.md'])]);
    expect(openTab).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('opens a file added later, once, and names the agent', () => {
    const { openTab, notify, rerender } = setup([session(['/d/a.md'], { author: 'Claude' })]);
    rerender([session(['/d/a.md', '/d/b.md'], { author: 'Claude' })]);

    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith('/d/b.md');
    expect(notify).toHaveBeenCalledWith('Claude added b.md to this review');

    // The next poll carries the same list: nothing opens again, so a tab the
    // reader closed stays closed.
    rerender([session(['/d/a.md', '/d/b.md'], { author: 'Claude' })]);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it('says "Agent" before the session has a name, and handles Windows paths', () => {
    const { notify, rerender } = setup([session(['C:\\docs\\a.md'])]);
    rerender([session(['C:\\docs\\a.md', 'C:\\docs\\b.md', 'C:\\docs\\c.md'])]);
    expect(notify).toHaveBeenCalledWith('Agent added b.md, c.md to this review');
  });

  it('opens a file added while the review was out of view, once it is back', () => {
    const { openTab, rerender } = setup([session(['/d/a.md'])]);
    rerender([]);
    rerender([session(['/d/a.md', '/d/b.md'])]);
    expect(openTab).toHaveBeenCalledWith('/d/b.md');
  });

  it('never reopens an added file the reader closed, even after the review leaves and returns', () => {
    const { openTab, rerender } = setup([session(['/d/a.md'])]);
    rerender([session(['/d/a.md', '/d/b.md'])]);
    expect(openTab).toHaveBeenCalledTimes(1);
    // The reader closes both tabs, then reopens a.md: the review returns.
    rerender([]);
    rerender([session(['/d/a.md', '/d/b.md'])]);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it('opens a file added after the page loaded but before the first sighting', () => {
    // The race: ?review= opened a.md, then b.md was added before the first
    // poll showed the session, so it is already in the list when first seen.
    const { openTab, notify } = setup([
      session(['/d/a.md', '/d/b.md'], {
        author: 'Claude',
        fileAddedAt: { '/d/b.md': '2026-09-24T12:00:02Z' },
      }),
    ]);
    expect(openTab).toHaveBeenCalledWith('/d/b.md');
    expect(notify).toHaveBeenCalledWith('Claude added b.md to this review');
  });

  it('ignores the timestamps of a review this page was not opened for', () => {
    // A tab loaded hours ago, never on this review, now shows it because the
    // reader opened a.md: b.md was added long after load, but it is not news
    // to a tab that never showed the review.
    const { openTab, notify } = setup([
      session(['/d/a.md', '/d/b.md'], {
        id: 'rev_other',
        fileAddedAt: { '/d/b.md': '2026-09-24T12:00:02Z' },
      }),
    ]);
    expect(openTab).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('leaves a file that was added before the page loaded', () => {
    // A window opened later on an already-widened review: nothing is news.
    const { openTab } = setup([
      session(['/d/a.md', '/d/b.md'], { fileAddedAt: { '/d/b.md': '2026-09-24T11:59:00Z' } }),
    ]);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('tracks each review on its own', () => {
    const { openTab, rerender } = setup([
      session(['/d/a.md'], { id: 'rev_1' }),
      session(['/d/x.md'], { id: 'rev_2' }),
    ]);
    rerender([
      session(['/d/a.md'], { id: 'rev_1' }),
      session(['/d/x.md', '/d/y.md'], { id: 'rev_2' }),
    ]);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith('/d/y.md');
  });
});
