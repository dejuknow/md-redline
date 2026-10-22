// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMemo, useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

    expect(onHandoffSuccess).toHaveBeenCalledWith(session);
    expect(onResolved).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    const toastMessage = showToast.mock.calls[0][0];
    expect(toastMessage).toContain('3 comments');
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
