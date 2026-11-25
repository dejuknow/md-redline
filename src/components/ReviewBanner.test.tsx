// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMemo, useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ReviewBanner } from './ReviewBanner';
import type { ReviewSession } from '../hooks/useReviewSession';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const session: ReviewSession = {
  id: 'rev_1',
  filePaths: ['/tmp/spec-a.md', '/tmp/spec-b.md'],
  enableResolve: false,
  status: 'open',
  sentCommentIds: [],
  waitingForAgent: false,
  origin: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ReviewBanner', () => {
  it('renders the file list when sessions are present', () => {
    const { container } = render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 2],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1', 'c2']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    expect(screen.getByText(/Agent is waiting/i)).not.toBeNull();
    expect(container.textContent).toContain('spec-a.md');
    expect(container.textContent).toContain('spec-b.md');
  });

  it('renders nothing when there are no sessions', () => {
    const { container } = render(
      <ReviewBanner
        sessions={[]}
        commentCounts={new Map()}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('Send batch POSTs to /batch with prompt and commentIds', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onHandoffSuccess = vi.fn();
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 2],
            ['/tmp/spec-b.md', 1],
          ])
        }
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1', 'c2']],
            ['/tmp/spec-b.md', ['c3']],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/batch',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'content-type': 'application/json' }),
        }),
      );
    });

    const callBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.prompt).toContain("I've left review comments");
    expect(callBody.prompt).toContain('/tmp/spec-a.md');
    expect(callBody.commentIds).toEqual(['c1', 'c2', 'c3']);
    // The session stays open after a batch, so the agent may ask in it.
    expect(callBody.prompt).toContain('mdr_ask');
    expect(callBody.prompt).toContain('"rev_1"');

    expect(onHandoffSuccess).toHaveBeenCalledWith(session);
    expect(onResolved).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    const toastMessage = showToast.mock.calls[0][0];
    expect(toastMessage).toContain('3 comments');
  });

  const allSentCounts = new Map([
    ['/tmp/spec-a.md', 0],
    ['/tmp/spec-b.md', 0],
  ]);
  const oneUnsentIds = new Map([
    ['/tmp/spec-a.md', ['c1']],
    ['/tmp/spec-b.md', []],
  ]);

  it.each([/send \d+ comment/i, /send \d+ & finish/i])(
    '%s sends nothing when a session file failed to save',
    async (button) => {
      const prepareSend = vi.fn(() => Promise.resolve(null));
      render(
        <ReviewBanner
          sessions={[session]}
          commentCounts={
            new Map([
              ['/tmp/spec-a.md', 1],
              ['/tmp/spec-b.md', 0],
            ])
          }
          onResolved={() => {}}
          prepareSend={prepareSend}
          commentIdsByFile={oneUnsentIds}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: button }));

      await waitFor(() => expect(prepareSend).toHaveBeenCalledWith(session.filePaths));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('Send records the diff reference only after the post succeeds', async () => {
    let answer: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    const commit = vi.fn();
    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onResolved={() => {}}
        prepareSend={() => Promise.resolve(commit)}
        commentIdsByFile={oneUnsentIds}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(commit).not.toHaveBeenCalled();

    answer({ ok: true, json: async () => ({ ok: true }) } as Response);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  });

  // The busy state used to be claimed after the save wait, so a second click
  // in that window captured the same unsent ids and posted them again.
  it('a second Send click while the first waits on a save posts once', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    let saved: (commit: () => void) => void = () => {};
    const prepareSend = vi.fn(() => new Promise<() => void>((resolve) => (saved = resolve)));
    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onResolved={() => {}}
        prepareSend={prepareSend}
        commentIdsByFile={oneUnsentIds}
      />,
    );

    const send = screen.getByRole('button', { name: /send \d+ comment/i });
    fireEvent.click(send);
    fireEvent.click(send);
    saved(() => {});

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(prepareSend).toHaveBeenCalledTimes(1);
  });

  it("a send waiting on one review leaves another review's buttons working", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const other: ReviewSession = { ...session, id: 'rev_2', filePaths: ['/tmp/spec-c.md'] };
    const prepareSend = vi.fn((paths: string[]) =>
      paths.includes('/tmp/spec-a.md')
        ? new Promise<() => void>(() => {}) // rev_1 stays waiting on a save
        : Promise.resolve(() => {}),
    );
    render(
      <ReviewBanner
        sessions={[session, other]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
            ['/tmp/spec-c.md', 1],
          ])
        }
        onResolved={() => {}}
        prepareSend={prepareSend}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
            ['/tmp/spec-c.md', ['c9']],
          ])
        }
      />,
    );

    const sends = screen.getAllByRole('button', { name: /send \d+ comment/i });
    fireEvent.click(sends[0]);
    fireEvent.click(sends[1]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/review-sessions/rev_2/batch', expect.anything()),
    );
  });

  // The poll reports hasQueuedBatch seconds later; a finish in between still
  // carries the queued batch, so it still waits on saves.
  it('Finish review right after a queued Send checks saves before the poll catches up', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, queued: true }),
    } as Response);
    const prepareSend = vi.fn(() => Promise.resolve<(() => void) | null>(() => {}));
    const { rerender } = render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onResolved={() => {}}
        prepareSend={prepareSend}
        commentIdsByFile={oneUnsentIds}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The parent records c1 as sent; the session itself has not polled yet.
    rerender(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onResolved={() => {}}
        prepareSend={prepareSend}
        optimisticSent={{ commentIds: new Set(['c1']), replyKeys: new Set() }}
        commentIdsByFile={oneUnsentIds}
      />,
    );
    prepareSend.mockClear();
    prepareSend.mockResolvedValueOnce(null);
    fireEvent.click(await screen.findByRole('button', { name: /finish review/i }));

    await waitFor(() => expect(prepareSend).toHaveBeenCalledWith(session.filePaths));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A finish that carries nothing new hands nothing off: resetting the diff
  // then would hide the agent's last round of edits. Nor does it read any
  // file, so it does not wait on saves, even while the agent is busy.
  it('Finish review with nothing to send leaves the diff and skips the save check', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onHandoffSuccess = vi.fn();
    const onResolved = vi.fn();
    const prepareSend = vi.fn(() => Promise.resolve(() => {}));
    render(
      <ReviewBanner
        sessions={[{ ...session, sentCommentIds: ['c1'], waitingForAgent: true }]}
        commentCounts={allSentCounts}
        onHandoffSuccess={onHandoffSuccess}
        prepareSend={prepareSend}
        onResolved={onResolved}
        commentIdsByFile={oneUnsentIds}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(onHandoffSuccess).not.toHaveBeenCalled();
    expect(prepareSend).not.toHaveBeenCalled();
  });

  // The server folds a queued batch into the finish, and the agent then reads
  // the files. A batch queues between agent polls too, with waitingForAgent
  // false, so the server's own flag decides.
  it('Finish review checks saves when a queued batch rides along', async () => {
    const prepareSend = vi.fn(() => Promise.resolve(null));
    render(
      <ReviewBanner
        sessions={[{ ...session, sentCommentIds: ['c1'], hasQueuedBatch: true }]}
        commentCounts={allSentCounts}
        prepareSend={prepareSend}
        onResolved={() => {}}
        commentIdsByFile={oneUnsentIds}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));

    await waitFor(() => expect(prepareSend).toHaveBeenCalledWith(session.filePaths));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Finish review with zero unsent comments POSTs to /finish with commentCounts but no prompt', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();

    const sessionAllSent: ReviewSession = {
      ...session,
      sentCommentIds: ['c1', 'c2'],
    };

    render(
      <ReviewBanner
        sessions={[sessionAllSent]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 0],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', ['c2']],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/finish',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // No prompt or ids when there are zero unsent comments, but the counts
    // still go along so the server can rebuild the prompt for a queued batch.
    const callInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(callInit.body as string)).toEqual({
      commentCounts: { '/tmp/spec-a.md': 0, '/tmp/spec-b.md': 0 },
    });

    expect(onResolved).toHaveBeenCalled();
  });

  it('Send batch is disabled when waitingForAgent is true', () => {
    const waitingSession: ReviewSession = {
      ...session,
      waitingForAgent: true,
    };

    render(
      <ReviewBanner
        sessions={[waitingSession]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 2],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    const batchButton = screen.getByRole('button', { name: /waiting for agent/i });
    expect((batchButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('Send batch is disabled when no unsent comments exist', () => {
    const sessionAllSent: ReviewSession = {
      ...session,
      sentCommentIds: ['c1', 'c2'],
    };

    render(
      <ReviewBanner
        sessions={[sessionAllSent]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 1],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', ['c2']],
          ])
        }
      />,
    );

    const batchButton = screen.getByRole('button', { name: /send \d+ comment/i });
    expect((batchButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('Send & finish calls /finish with prompt and commentIds', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onHandoffSuccess = vi.fn();
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 1],
          ])
        }
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', ['c2']],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ & finish/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/finish',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'content-type': 'application/json' }),
        }),
      );
    });

    const callBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.prompt).toBeDefined();
    expect(callBody.commentIds).toEqual(['c1', 'c2']);
    // Finish closes the session, so the prompt must not offer mdr_ask on it.
    expect(callBody.prompt).not.toContain('mdr_ask');
    expect(callBody.commentCounts).toEqual({ '/tmp/spec-a.md': 1, '/tmp/spec-b.md': 1 });

    expect(onHandoffSuccess).toHaveBeenCalledWith(session);
    expect(onResolved).toHaveBeenCalled();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(showToast.mock.calls[0][0]).toContain('Review finished');
  });

  it('Cancel review POSTs to the abort endpoint, calls onResolved, and shows a toast', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={new Map()}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/abort',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(onResolved).toHaveBeenCalled();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Review cancelled', 'info');
    });
  });

  it('disables Send batch and labels the button "Loading..." until every session file has a comment count', () => {
    render(
      <ReviewBanner
        sessions={[session]}
        // spec-a is known, spec-b is still loading
        commentCounts={new Map([['/tmp/spec-a.md', 2]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']]])}
      />,
    );

    const loadingButtons = screen.getAllByRole('button', { name: /loading/i });
    expect(loadingButtons.length).toBeGreaterThanOrEqual(1);
    expect((loadingButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^send batch$/i })).toBeNull();
  });

  it('does NOT call onHandoffSuccess or onResolved when the batch POST returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Session is not open' }),
    } as Response);
    const onHandoffSuccess = vi.fn();
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    const toastMessage = showToast.mock.calls[0][0] as string;
    expect(toastMessage).toContain('Batch send failed');
    expect(toastMessage).toContain('Session is not open');

    expect(onHandoffSuccess).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('does NOT call onHandoffSuccess or onResolved when the batch fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const onHandoffSuccess = vi.fn();
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    const toastMessage = showToast.mock.calls[0][0] as string;
    expect(toastMessage).toContain('Batch send failed');
    expect(toastMessage).toContain('connection refused');

    expect(onHandoffSuccess).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('shows an error toast when the cancel POST returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Session not found' }),
    } as Response);
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={new Map()}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel review/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(showToast.mock.calls[0][0] as string).toContain('Cancel failed');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('Send batch calls onBatchSent with the sent comment IDs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onBatchSent = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 2],
            ['/tmp/spec-b.md', 1],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        onBatchSent={onBatchSent}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1', 'c2']],
            ['/tmp/spec-b.md', ['c3']],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      expect(onBatchSent).toHaveBeenCalledWith(['c1', 'c2', 'c3'], []);
    });
  });

  it('does NOT call onResolved when the finish POST returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Session is not open' }),
    } as Response);
    const onResolved = vi.fn();
    const showToast = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ & finish/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(showToast.mock.calls[0][0] as string).toContain('Finish failed');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('Finish review with zero unsent comments calls /finish with no prompt, only commentCounts', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();
    const showToast = vi.fn();

    const sessionAllSent: ReviewSession = {
      ...session,
      sentCommentIds: ['c1'],
    };

    render(
      <ReviewBanner
        sessions={[sessionAllSent]}
        commentCounts={
          new Map([
            ['/tmp/spec-a.md', 1],
            ['/tmp/spec-b.md', 0],
          ])
        }
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', []],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/finish',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const callInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(callInit.body as string)).toEqual({
      commentCounts: { '/tmp/spec-a.md': 1, '/tmp/spec-b.md': 0 },
    });

    expect(onResolved).toHaveBeenCalled();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(showToast.mock.calls[0][0]).toContain('Review finished');
  });

  it('only includes comment IDs from session files, not other open tabs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onBatchSent = vi.fn();

    // Session only covers spec-a, but spec-b and spec-c are also open
    const singleFileSession: ReviewSession = {
      ...session,
      filePaths: ['/tmp/spec-a.md'],
    };

    render(
      <ReviewBanner
        sessions={[singleFileSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        onBatchSent={onBatchSent}
        commentIdsByFile={
          new Map([
            ['/tmp/spec-a.md', ['c1']],
            ['/tmp/spec-b.md', ['c2', 'c3']],
            ['/tmp/spec-c.md', ['c4']],
          ])
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      // Only c1 from spec-a should be sent, not c2/c3/c4 from other files
      expect(onBatchSent).toHaveBeenCalledWith(['c1'], []);
    });
  });
});

describe('ReviewBanner — unified agent-reviewing banner (wait-mode and fire-and-forget)', () => {
  const agentSession: ReviewSession = {
    id: 'rev_agent',
    filePaths: ['/tmp/spec-a.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAgentActivityAt: null,
    author: 'Claude',
  };

  // Helper for rendering an agent-origin session banner
  function renderAgentBanner(overrides: Partial<Parameters<typeof ReviewBanner>[0]> = {}) {
    const defaultProps: Parameters<typeof ReviewBanner>[0] = {
      sessions: [agentSession],
      commentCounts: new Map([['/tmp/spec-a.md', 0]]),
      agentCommentCounts: new Map([['/tmp/spec-a.md', 0]]),
      onHandoffSuccess: () => {},
      onResolved: () => {},
      commentIdsByFile: new Map([['/tmp/spec-a.md', []]]),
    };
    return render(<ReviewBanner {...{ ...defaultProps, ...overrides }} />);
  }

  it('shows "End review" button for agent sessions', () => {
    renderAgentBanner();
    expect(screen.getByRole('button', { name: /end review/i })).not.toBeNull();
  });

  // ─── Awaiting-reply state ────────────────────────────────────────────────

  it('switches to awaiting-reply copy with a question chip when asks are pending', () => {
    const onJumpToAsk = vi.fn();
    renderAgentBanner({
      pendingAskCountsBySession: new Map([['rev_agent', 2]]),
      onJumpToAsk,
    });
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent).toContain('Claude is waiting on your reply');
    const chip = screen.getByRole('button', { name: /2 questions awaiting your reply/i });
    fireEvent.click(chip);
    expect(onJumpToAsk).toHaveBeenCalledWith('rev_agent');
  });

  it('End review asks for confirmation while questions are pending', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      renderAgentBanner({ pendingAskCountsBySession: new Map([['rev_agent', 1]]) });
      fireEvent.click(screen.getByRole('button', { name: /end review/i }));
      expect(confirmSpy).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: /end review/i }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/review-sessions/rev_agent/agent-done',
          expect.objectContaining({ method: 'POST' }),
        );
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('does not ask for confirmation when no questions are pending', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const confirmSpy = vi.spyOn(window, 'confirm');
    try {
      renderAgentBanner();
      fireEvent.click(screen.getByRole('button', { name: /end review/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('shows "is reviewing" copy in the banner', () => {
    renderAgentBanner();
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('is reviewing');
  });

  it('Done POSTs to /agent-done and calls onResolved', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();
    renderAgentBanner({ onResolved });

    fireEvent.click(screen.getByRole('button', { name: /end review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_agent/agent-done',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(onResolved).toHaveBeenCalled();
  });

  it('shows error toast when Done POST returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Already done' }),
    } as Response);
    const showToast = vi.fn();
    renderAgentBanner({ showToast });

    fireEvent.click(screen.getByRole('button', { name: /end review/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect((showToast.mock.calls[0][0] as string).toLowerCase()).toContain("couldn't end review");
  });

  it('button is disabled while request is in flight', async () => {
    let resolveDone: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveDone = r;
        }),
    );
    renderAgentBanner();

    const btn = screen.getByRole('button', { name: /end review/i });
    fireEvent.click(btn);
    expect(
      (screen.getByRole('button', { name: /end review/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveDone({ ok: true, json: async () => ({ ok: true }) } as Response);
  });

  // ─── Spinner / dot indicator ─────────────────────────────────────────────

  it('shows spinner when lastAgentActivityAt is recent (within 30s)', () => {
    const activeSession: ReviewSession = {
      ...agentSession,
      lastAgentActivityAt: new Date(Date.now() - 10_000).toISOString(),
    };
    renderAgentBanner({
      sessions: [activeSession],
      agentCommentCounts: new Map([['/tmp/spec-a.md', 1]]),
    });
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows static dot when lastAgentActivityAt is stale (older than 30s)', () => {
    const staleSession: ReviewSession = {
      ...agentSession,
      lastAgentActivityAt: new Date(Date.now() - 60_000).toISOString(),
    };
    renderAgentBanner({ sessions: [staleSession] });
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).toBeNull();
    expect(banner.querySelector('[aria-hidden]')).not.toBeNull();
  });

  it('shows spinner when lastAgentActivityAt is null (just-started session)', () => {
    // A session with no activity yet is one the agent just opened and is
    // about to post into. The idle dot is reserved for "posted a while ago
    // and gone quiet" — showing it at session start misread as "finished".
    renderAgentBanner();
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).not.toBeNull();
  });

  // ─── Comment count ──────────────────────────────────────────────────────

  it('shows comment count when comments exist', () => {
    renderAgentBanner({
      agentCommentCounts: new Map([['/tmp/spec-a.md', 3]]),
    });
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent).toContain('3 comments');
  });

  it('does not show comment count before any comments arrive', () => {
    renderAgentBanner();
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).not.toContain('comments');
  });

  // ─── Agent name ─────────────────────────────────────────────────────────

  it('names the agent from the session, not from comment markers', () => {
    // No comment markers are passed in at all: the name comes from the session
    // the server returns, so a reply-only session, or one on a file with no
    // open tab, is still labelled (#113).
    renderAgentBanner();
    expect(screen.getByTestId('review-banner').textContent).toContain('Claude is reviewing');
  });

  it('uses "Agent" until a batch has supplied a name', () => {
    renderAgentBanner({ sessions: [{ ...agentSession, author: undefined }] });
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('agent is reviewing');
  });

  // ─── User-origin session doesn't use the unified banner ─────────────────

  it('does not show the agent-reviewing banner for user-origin sessions', () => {
    const userSession: ReviewSession = {
      ...agentSession,
      id: 'rev_user',
      origin: 'user',
    };
    renderAgentBanner({ sessions: [userSession] });
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).not.toContain('is reviewing');
  });

  it('user-origin session renders the "Agent is waiting" banner (regression guard)', () => {
    const userSession: ReviewSession = {
      ...agentSession,
      id: 'rev_user2',
      origin: 'user',
    };
    render(
      <ReviewBanner
        sessions={[userSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 3]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 3]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2', 'c3']]])}
      />,
    );
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('agent is waiting on your review');
  });
});

describe('Agent session Done button', () => {
  const agentSession: ReviewSession = {
    id: 'rev_agent_1',
    filePaths: ['/tmp/prd.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAgentActivityAt: null,
  };

  it('renders Done button for agent sessions', () => {
    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/prd.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/prd.md', []]])}
        agentCommentCounts={new Map([['/tmp/prd.md', 2]])}
      />,
    );
    expect(screen.getByRole('button', { name: /end review/i })).not.toBeNull();
  });

  it('Done button POSTs to /agent-done then calls onResolved', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();

    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/prd.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        commentIdsByFile={new Map([['/tmp/prd.md', []]])}
        agentCommentCounts={new Map([['/tmp/prd.md', 2]])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /end review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_agent_1/agent-done',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(onResolved).toHaveBeenCalled();
  });

  it('Done button shows the agent name stored on the session', () => {
    render(
      <ReviewBanner
        sessions={[{ ...agentSession, author: 'Codex' }]}
        commentCounts={new Map([['/tmp/prd.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/prd.md', []]])}
        agentCommentCounts={new Map([['/tmp/prd.md', 3]])}
      />,
    );
    expect(screen.getByText(/Codex is reviewing/)).not.toBeNull();
  });
});

describe('ReviewBanner: a reviewer reply on a sent thread', () => {
  const FILE = '/tmp/spec-a.md';
  const counts = new Map([[FILE, 2]]);
  // c1 was sent in an earlier batch; the reviewer has since replied on it.
  const sentThread: ReviewSession = {
    ...session,
    filePaths: [FILE],
    sentCommentIds: ['c1'],
    sentReplyIds: [],
  };

  interface HarnessProps {
    session: ReviewSession;
    userRepliedLast: Map<string, string>;
    ids?: string[];
    showToast?: () => void;
    onBatchSent?: (ids: string[], keys: string[]) => void;
  }

  // Plays the part App plays: it records what the banner reports as sent and
  // hands it back, while the `session` prop only changes when a test says the
  // poll came back.
  function Harness({
    session: s,
    userRepliedLast,
    ids = ['c1'],
    showToast,
    onBatchSent,
  }: HarnessProps) {
    const [sentIds, setSentIds] = useState<string[]>([]);
    const [sentKeys, setSentKeys] = useState<string[]>([]);
    const optimisticSent = useMemo(
      () => ({ commentIds: new Set(sentIds), replyKeys: new Set(sentKeys) }),
      [sentIds, sentKeys],
    );
    return (
      <ReviewBanner
        sessions={[s]}
        commentCounts={counts}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        onBatchSent={(sent, keys) => {
          setSentIds((prev) => [...prev, ...sent]);
          setSentKeys((prev) => [...prev, ...keys]);
          onBatchSent?.(sent, keys);
        }}
        optimisticSent={optimisticSent}
        showToast={showToast}
        commentIdsByFile={new Map([[FILE, ids]])}
        userRepliedLast={userRepliedLast}
      />
    );
  }

  const sendButton = () => screen.getByRole('button', { name: /send \d+ comment/i });
  const lastBody = () => {
    const calls = fetchMock.mock.calls;
    return JSON.parse((calls[calls.length - 1][1] as RequestInit).body as string);
  };

  it('turns Send on, and off again once the reply is sent, even after a refresh', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const replied = new Map([['c1', 'r1~a']]);

    const { rerender } = render(
      <Harness session={sentThread} userRepliedLast={replied} showToast={showToast} />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    expect(sendButton().textContent).toBe('Send 1 comment');

    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ commentIds: ['c1'], replyIds: ['r1~a'] });

    // The session refresh brings back what the server recorded.
    const refreshed = { ...sentThread, sentReplyIds: ['r1~a'] };
    rerender(<Harness session={refreshed} userRepliedLast={replied} showToast={showToast} />);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(sendButton().textContent).toBe('Send 0 comments');

    // A later poll returns an equal session in a new object: still off, also
    // while the agent has not answered yet.
    rerender(
      <Harness
        session={{ ...refreshed }}
        userRepliedLast={new Map(replied)}
        showToast={showToast}
      />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);

    // And once the agent answers, the thread is no longer a reviewer-last one.
    rerender(<Harness session={refreshed} userRepliedLast={new Map()} showToast={showToast} />);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns Send off the moment it is sent, before the session reports it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const onBatchSent = vi.fn();

    // The session prop is never refreshed here: the poll has not come back.
    render(
      <Harness
        session={sentThread}
        userRepliedLast={new Map([['c1', 'r1~a']])}
        showToast={showToast}
        onBatchSent={onBatchSent}
      />,
    );
    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(onBatchSent).toHaveBeenCalledWith(['c1'], ['r1~a']);

    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(sendButton().textContent).toBe('Send 0 comments');
    fireEvent.click(sendButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not offer a first send again before the session reports it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const fresh = { ...sentThread, sentCommentIds: [] };

    render(
      <Harness
        session={fresh}
        userRepliedLast={new Map()}
        ids={['c1', 'c2']}
        showToast={showToast}
      />,
    );
    expect(sendButton().textContent).toBe('Send 2 comments');
    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(sendButton().textContent).toBe('Send 0 comments');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns Send on again for a newer reviewer reply and sends only that reply', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const sentOnce = { ...sentThread, sentReplyIds: ['r1~a'] };

    const { rerender } = render(
      <Harness session={sentOnce} userRepliedLast={new Map([['c1', 'r1~a']])} />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <Harness
        session={sentOnce}
        userRepliedLast={new Map([['c1', 'r2~a']])}
        showToast={showToast}
      />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    expect(sendButton().textContent).toBe('Send 1 comment');

    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ commentIds: ['c1'], replyIds: ['r2~a'] });
  });

  it('turns Send on once for an edited reply, and leaves an unchanged one sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    // r1 went out as it read then; the reviewer has since corrected its text,
    // which keeps the id and changes the key.
    const sentOnce = { ...sentThread, sentReplyIds: ['r1~a'] };

    const { rerender } = render(
      <Harness session={sentOnce} userRepliedLast={new Map([['c1', 'r1~a']])} />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);

    const edited = new Map([['c1', 'r1~b']]);
    rerender(<Harness session={sentOnce} userRepliedLast={edited} showToast={showToast} />);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ commentIds: ['c1'], replyIds: ['r1~b'] });

    // Sent once: off again, with or without the poll, and a second edit-free
    // render does not send it a second time.
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <Harness
        session={{ ...sentOnce, sentReplyIds: ['r1~a', 'r1~b'] }}
        userRepliedLast={new Map(edited)}
        showToast={showToast}
      />,
    );
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts a never-sent comment as unsent, and sends its last reply with it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const unsent = { ...sentThread, sentCommentIds: [] };

    render(
      <Harness
        session={unsent}
        userRepliedLast={new Map([['c1', 'r1~a']])}
        ids={['c1', 'c2']}
        showToast={showToast}
      />,
    );
    expect(sendButton().textContent).toBe('Send 2 comments');

    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    // c2 has no reply, so only c1's reply key goes along.
    expect(lastBody()).toMatchObject({ commentIds: ['c1', 'c2'], replyIds: ['r1~a'] });
  });

  it('treats a session from a server without sentReplyIds as having sent none', () => {
    const legacy: ReviewSession = { ...sentThread };
    delete legacy.sentReplyIds;

    render(<Harness session={legacy} userRepliedLast={new Map([['c1', 'r1~a']])} />);
    expect(sendButton().textContent).toBe('Send 1 comment');
  });

  it('Send & finish leaves out a reply that was already sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const sentOnce = { ...sentThread, sentReplyIds: ['r1~a'] };

    // Only c1's already-sent reply: nothing to send, so the button just finishes.
    const { rerender } = render(
      <Harness
        session={sentOnce}
        userRepliedLast={new Map([['c1', 'r1~a']])}
        showToast={showToast}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastBody()).toEqual({ commentCounts: { [FILE]: 2 } });

    // With a new comment c2 alongside it, only c2 rides along.
    fetchMock.mockClear();
    showToast.mockClear();
    rerender(
      <Harness
        session={sentOnce}
        userRepliedLast={new Map([['c1', 'r1~a']])}
        ids={['c1', 'c2']}
        showToast={showToast}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send 1 & finish/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const body = lastBody();
    expect(body.commentIds).toEqual(['c2']);
    expect(body.replyIds).toEqual([]);
    expect(body.prompt).not.toContain('`c1`');
  });

  it('Send & finish leaves out a reply sent a moment ago, before the session reports it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();

    render(
      <Harness
        session={sentThread}
        userRepliedLast={new Map([['c1', 'r1~a']])}
        showToast={showToast}
      />,
    );
    fireEvent.click(sendButton());
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    showToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(fetchMock.mock.calls[1][0]).toBe('/api/review-sessions/rev_1/finish');
    expect(lastBody()).toEqual({ commentCounts: { [FILE]: 2 } });
  });

  it('Send & finish includes a reply the session has not sent, and reports it as sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    const onBatchSent = vi.fn();
    const sentOnce = { ...sentThread, sentReplyIds: ['r1~a'] };

    render(
      <Harness
        session={sentOnce}
        userRepliedLast={new Map([['c1', 'r2~a']])}
        showToast={showToast}
        onBatchSent={onBatchSent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send 1 & finish/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/review-sessions/rev_1/finish');
    expect(lastBody()).toMatchObject({ commentIds: ['c1'], replyIds: ['r2~a'] });
    expect(onBatchSent).toHaveBeenCalledWith(['c1'], ['r2~a']);
  });
});

describe('ReviewBanner: header layout', () => {
  const userSession: ReviewSession = {
    id: 'rev_user',
    filePaths: ['/tmp/user.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const agentSession: ReviewSession = {
    id: 'rev_agent',
    filePaths: ['/tmp/agent.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAgentActivityAt: null,
    author: 'Claude',
  };

  function renderHeaderBanner(overrides: Partial<Parameters<typeof ReviewBanner>[0]> = {}) {
    const props: Parameters<typeof ReviewBanner>[0] = {
      layout: 'header',
      sessions: [userSession, agentSession],
      commentCounts: new Map([
        ['/tmp/user.md', 2],
        ['/tmp/agent.md', 0],
      ]),
      agentCommentCounts: new Map([['/tmp/agent.md', 0]]),
      onResolved: () => {},
      commentIdsByFile: new Map([
        ['/tmp/user.md', ['u1', 'u2']],
        ['/tmp/agent.md', []],
      ]),
      ...overrides,
    };
    return render(<ReviewBanner {...props} />);
  }

  it('header layout shows one row and a "+1" Other reviews button when two sessions are present', () => {
    renderHeaderBanner();
    const banner = screen.getByTestId('review-banner');
    // The user review is ready to send, so it takes the row.
    expect(banner.textContent).toContain('Agent is waiting on your review');
    expect(banner.textContent).not.toContain('Claude is reviewing');
    const others = screen.getByRole('button', { name: 'Other reviews' });
    expect(others.textContent).toBe('+1');
    expect(others.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(others);
    expect(others.getAttribute('aria-expanded')).toBe('true');
    expect(banner.textContent).toContain('Claude is reviewing');
  });

  it('shows no Other reviews button for a single session', () => {
    renderHeaderBanner({ sessions: [userSession] });
    expect(screen.queryByRole('button', { name: 'Other reviews' })).toBeNull();
  });

  it('actions inside the popover act on their own session id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();
    renderHeaderBanner({ onResolved });
    fireEvent.click(screen.getByRole('button', { name: 'Other reviews' }));
    const popover = screen.getByRole('dialog', { name: 'Other reviews' });
    fireEvent.click(
      Array.from(popover.querySelectorAll('button')).find((b) =>
        /end review/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
      )!,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_agent/agent-done',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('End review renders without bg-primary', () => {
    renderHeaderBanner({ sessions: [agentSession] });
    const end = screen.getByRole('button', { name: /end review/i });
    expect(end.className).not.toMatch(/\bbg-primary\b/);
  });

  it('End review renders without bg-primary in the banner layout too', () => {
    renderHeaderBanner({ sessions: [agentSession], layout: 'banner' });
    const end = screen.getByRole('button', { name: /end review/i });
    expect(end.className).not.toMatch(/\bbg-primary\b/);
  });

  it('row actions render quiet, secondary, primary, with the primary last', () => {
    renderHeaderBanner({ sessions: [userSession] });
    const banner = screen.getByTestId('review-banner');
    const labels = Array.from(banner.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Cancel review', 'Send 2 & finish', 'Send 2 comments']);
    const send = screen.getByRole('button', { name: 'Send 2 comments' });
    expect(send.className).toMatch(/\bbg-primary\b/);
  });

  it('compact: Send N & finish and Cancel review live in the "More review actions" menu and still act on the row\'s session', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();
    renderHeaderBanner({ sessions: [userSession], compact: true, onResolved });
    // The primary stays out; the rest are behind the menu.
    expect(screen.getByRole('button', { name: 'Send 2 comments' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send 2 & finish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel review' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
    const menu = screen.getByRole('menu', { name: 'More review actions' });
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(items).toEqual(['Cancel review', 'Send 2 & finish']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Send 2 & finish' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_user/finish',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    // Choosing an item closes the menu.
    expect(screen.queryByRole('menu', { name: 'More review actions' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel review' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_user/abort',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('compact: End review moves into the menu on an agent row', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    renderHeaderBanner({ sessions: [agentSession], compact: true });
    expect(screen.queryByRole('button', { name: /end review/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /end review/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_agent/agent-done',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('compact: the pending-question jump stays visible on a user-origin row', () => {
    const onJumpToAsk = vi.fn();
    renderHeaderBanner({
      sessions: [userSession],
      compact: true,
      pendingAskCountsBySession: new Map([['rev_user', 1]]),
      onJumpToAsk,
    });
    const jump = screen.getByRole('button', { name: /1 question awaiting your reply/i });
    fireEvent.click(jump);
    expect(onJumpToAsk).toHaveBeenCalledWith('rev_user');
  });

  it('compact: the pending-question jump stays visible on an agent row', () => {
    renderHeaderBanner({
      sessions: [agentSession],
      compact: true,
      pendingAskCountsBySession: new Map([['rev_agent', 2]]),
      onJumpToAsk: () => {},
    });
    expect(screen.getByRole('button', { name: /2 questions awaiting your reply/i })).toBeTruthy();
  });

  it('a user session waiting for the agent does not rank as ready', () => {
    const waiting: ReviewSession = { ...userSession, id: 'rev_waiting', waitingForAgent: true };
    const ready: ReviewSession = {
      ...userSession,
      id: 'rev_ready',
      filePaths: ['/tmp/ready.md'],
    };
    renderHeaderBanner({
      sessions: [waiting, ready],
      commentCounts: new Map([
        ['/tmp/user.md', 2],
        ['/tmp/ready.md', 1],
      ]),
      commentIdsByFile: new Map([
        ['/tmp/user.md', ['u1', 'u2']],
        ['/tmp/ready.md', ['r1']],
      ]),
    });
    // The ready review's Send is the one in the row.
    expect(screen.getByRole('button', { name: 'Send 1 comment' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /waiting for agent/i })).toBeNull();
  });

  describe('the shown review holds the row', () => {
    const sessionA: ReviewSession = { ...userSession, id: 'rev_a', filePaths: ['/tmp/a.md'] };
    const sessionB: ReviewSession = { ...userSession, id: 'rev_b', filePaths: ['/tmp/b.md'] };
    const agentB: ReviewSession = { ...agentSession, id: 'rev_agent_b' };

    // Plays App's part: records what the banner reports as sent and hands it
    // back as optimisticSent.
    function StableHarness({
      sessions,
      asks,
      compact = false,
    }: {
      sessions: ReviewSession[];
      asks?: Map<string, number>;
      compact?: boolean;
    }) {
      const [sentIds, setSentIds] = useState<string[]>([]);
      const optimisticSent = useMemo(
        () => ({ commentIds: new Set(sentIds), replyKeys: new Set<string>() }),
        [sentIds],
      );
      return (
        <ReviewBanner
          layout="header"
          compact={compact}
          sessions={sessions}
          commentCounts={
            new Map([
              ['/tmp/a.md', 2],
              ['/tmp/b.md', 1],
              ['/tmp/agent.md', 0],
            ])
          }
          onResolved={() => {}}
          onBatchSent={(sent) => setSentIds((prev) => [...prev, ...sent])}
          optimisticSent={optimisticSent}
          commentIdsByFile={
            new Map([
              ['/tmp/a.md', ['a1', 'a2']],
              ['/tmp/b.md', ['b1']],
              ['/tmp/agent.md', []],
            ])
          }
          pendingAskCountsBySession={asks}
        />
      );
    }

    const rowText = () => screen.getByTestId('review-banner').textContent ?? '';

    it('picks by priority when the row is not held: a send on A hands the row to B', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
      render(<StableHarness sessions={[sessionA, sessionB]} />);
      expect(rowText()).toContain('a.md');
      fireEvent.click(screen.getByRole('button', { name: 'Send 2 comments' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // A has nothing left to send and B does, and nothing holds the row.
      await waitFor(() => expect(rowText()).toContain('b.md'));
      expect(screen.getByRole('button', { name: 'Send 1 comment' })).toBeTruthy();
    });

    it('a question elsewhere takes the row from a review ready to send when not held', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      expect(rowText()).toContain('a.md');
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('Claude is waiting on your reply.');
    });

    it('holds the shown review while the pointer is over the row, and lets go when it leaves', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
      const { rerender } = render(<StableHarness sessions={[sessionA, sessionB]} />);
      const banner = screen.getByTestId('review-banner');
      fireEvent.pointerEnter(banner);
      fireEvent.click(screen.getByRole('button', { name: 'Send 2 comments' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Send 2 comments' })).toBeNull(),
      );
      // A's batch is out and B is ready, but A keeps the row under the pointer.
      expect(rowText()).toContain('a.md');
      expect(screen.queryByRole('button', { name: 'Send 1 comment' })).toBeNull();
      rerender(
        <StableHarness
          sessions={[
            { ...sessionA, waitingForAgent: true, sentCommentIds: ['a1', 'a2'] },
            sessionB,
          ]}
          asks={new Map([['rev_agent_b', 1]])}
        />,
      );
      expect(rowText()).toContain('a.md');
      expect(screen.getByRole('button', { name: /waiting for agent/i })).toBeTruthy();
      fireEvent.pointerLeave(banner);
      expect(rowText()).toContain('b.md');
      expect(screen.getByRole('button', { name: 'Send 1 comment' })).toBeTruthy();
    });

    it('holds the shown review while one of its sends is in flight, pointer or not', async () => {
      let resolveFetch: (r: Response) => void = () => {};
      fetchMock.mockImplementation(
        () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
      );
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Send 2 comments' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // A question on B outranks A, but A's send is still out.
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('a.md');
      await act(async () => {
        resolveFetch({ ok: true, json: async () => ({ ok: true }) } as Response);
      });
      await waitFor(() => expect(rowText()).toContain('Claude is waiting on your reply.'));
    });

    it("a held review that ends shows the next one's row inert until the pointer leaves", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
      const { rerender } = render(<StableHarness sessions={[sessionA, sessionB]} />);
      const banner = screen.getByTestId('review-banner');
      fireEvent.pointerEnter(banner);
      // A finishes (say by Send & finish) and leaves the list.
      rerender(<StableHarness sessions={[sessionB]} />);
      expect(rowText()).toContain('b.md');
      const actions = banner.querySelector('[data-row-actions]') as HTMLElement;
      expect(actions.getAttribute('aria-disabled')).toBe('true');
      expect(actions.className).toMatch(/\bpointer-events-none\b/);
      const finish = screen.getByRole('button', { name: 'Send 1 & finish' });
      expect(finish.getAttribute('aria-disabled')).toBe('true');
      // The second click of a double click lands here and does nothing.
      fireEvent.click(finish);
      fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }));
      await act(async () => {});
      expect(fetchMock).not.toHaveBeenCalled();
      // Still inert after another poll while the pointer stays.
      rerender(<StableHarness sessions={[{ ...sessionB }]} />);
      expect(actions.getAttribute('aria-disabled')).toBe('true');

      fireEvent.pointerLeave(banner);
      const live = banner.querySelector('[data-row-actions]') as HTMLElement;
      expect(live.hasAttribute('aria-disabled')).toBe(false);
      expect(live.className).not.toMatch(/\bpointer-events-none\b/);
      expect(
        screen.getByRole('button', { name: 'Send 1 comment' }).hasAttribute('aria-disabled'),
      ).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/review-sessions/rev_b/batch',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    });

    it('a shown review that ends with no hold leaves the next row live', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, sessionB]} />);
      rerender(<StableHarness sessions={[sessionB]} />);
      const actions = screen.getByTestId('review-banner').querySelector('[data-row-actions]');
      expect(actions?.hasAttribute('aria-disabled')).toBe(false);
    });

    it('the +N button marks and names other reviews with questions waiting', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      const plain = screen.getByRole('button', { name: 'Other reviews' });
      expect(plain.querySelector('[data-questions-marker]')).toBeNull();
      // Held under the pointer, A keeps the row while B gets a question.
      fireEvent.pointerEnter(screen.getByTestId('review-banner'));
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('a.md');
      const marked = screen.getByRole('button', { name: 'Other reviews, 1 with questions' });
      const marker = marked.querySelector('[data-questions-marker]') as HTMLElement;
      // Amber, the colour for "waiting on you"; crimson is for actions.
      expect(marker.className).toMatch(/\bbg-warning\b/);
      expect(marker.className).not.toMatch(/\bbg-primary\b/);
      expect(marked.textContent).toBe('+1');
      expect(marked.getAttribute('title')).toBe('1 other review, 1 with questions');
    });

    it('holds the row while the Other reviews popover is open, pointer or not', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Other reviews' }));
      expect(screen.getByRole('dialog', { name: 'Other reviews' })).toBeTruthy();
      // A question on B outranks A, but the popover is open over A's row.
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('a.md');
      expect(screen.getByRole('dialog', { name: 'Other reviews' })).toBeTruthy();
      // Closed, the row goes to B.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Other reviews' })).toBeNull();
      expect(rowText()).toContain('Claude is waiting on your reply.');
    });

    it('holds the row while its More review actions menu is open', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} compact />);
      fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
      expect(screen.getByRole('menu', { name: 'More review actions' })).toBeTruthy();
      rerender(
        <StableHarness
          sessions={[sessionA, agentB]}
          asks={new Map([['rev_agent_b', 1]])}
          compact
        />,
      );
      expect(rowText()).toContain('a.md');
      expect(screen.getByRole('menuitem', { name: 'Send 2 & finish' })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(rowText()).toContain('Claude is waiting on your reply.');
    });

    it('holds the row while keyboard focus is inside it', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      const send = screen.getByRole('button', { name: 'Send 2 comments' });
      act(() => send.focus());
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('a.md');
      expect(document.activeElement).toBe(send);
      act(() => send.blur());
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('Claude is waiting on your reply.');
    });

    it('does not hold for focus a click left behind, once the pointer is gone', () => {
      const { rerender } = render(<StableHarness sessions={[sessionA, agentB]} />);
      const banner = screen.getByTestId('review-banner');
      const send = screen.getByRole('button', { name: 'Send 2 comments' });
      fireEvent.pointerEnter(banner);
      fireEvent.pointerDown(send);
      act(() => send.focus());
      fireEvent.pointerUp(send);
      fireEvent.pointerLeave(banner);
      rerender(
        <StableHarness sessions={[sessionA, agentB]} asks={new Map([['rev_agent_b', 1]])} />,
      );
      expect(rowText()).toContain('Claude is waiting on your reply.');
    });

    it("an inert row leaves the +N button and its popover usable; only the review's own actions are inert", () => {
      const sessionC: ReviewSession = { ...userSession, id: 'rev_c', filePaths: ['/tmp/b.md'] };
      const { rerender } = render(<StableHarness sessions={[sessionA, sessionB, sessionC]} />);
      const banner = screen.getByTestId('review-banner');
      fireEvent.pointerEnter(banner);
      // A ends under the pointer: B takes the row, inert.
      rerender(<StableHarness sessions={[sessionB, sessionC]} />);
      const actions = banner.querySelector('[data-row-actions]') as HTMLElement;
      expect(actions.getAttribute('aria-disabled')).toBe('true');
      const others = screen.getByRole('button', { name: 'Other reviews' });
      expect(actions.contains(others)).toBe(false);
      expect(others.closest('[aria-disabled]')).toBeNull();
      expect(others.closest('.pointer-events-none')).toBeNull();
      fireEvent.click(others);
      const popover = screen.getByRole('dialog', { name: 'Other reviews' });
      // The popover's rows are another review's, live.
      expect(popover.querySelector('[aria-disabled]')).toBeNull();
    });
  });

  it('the questions chip comes before the quiet End review on an agent row', () => {
    renderHeaderBanner({
      sessions: [agentSession],
      pendingAskCountsBySession: new Map([['rev_agent', 1]]),
      onJumpToAsk: () => {},
    });
    const labels = Array.from(screen.getByTestId('review-banner').querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    );
    expect(labels).toEqual([
      '1 question awaiting your reply. Jump to the first question.',
      'End review with Claude',
    ]);
  });

  it("a user review's status dot is amber", () => {
    renderHeaderBanner({ sessions: [userSession] });
    const dot = screen.getByTestId('review-banner').querySelector('.rounded-full');
    expect(dot?.className).toMatch(/\bbg-warning\b/);
  });

  it('the Other reviews popover gives up Escape to a dialog opened above it', () => {
    renderHeaderBanner();
    const others = screen.getByRole('button', { name: 'Other reviews' });
    fireEvent.click(others);
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.appendChild(overlay);
    try {
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
      expect(others.getAttribute('aria-expanded')).toBe('true');
    } finally {
      overlay.remove();
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(others.getAttribute('aria-expanded')).toBe('false');
  });

  it('the Other reviews popover closes when focus moves outside it (a palette opened by keyboard)', () => {
    renderHeaderBanner();
    const others = screen.getByRole('button', { name: 'Other reviews' });
    fireEvent.click(others);
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      act(() => input.focus());
      expect(others.getAttribute('aria-expanded')).toBe('false');
    } finally {
      input.remove();
    }
  });
});
