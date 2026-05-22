// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
};

describe('ReviewBanner', () => {
  it('renders the file list when sessions are present', () => {
    const { container } = render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={new Map([['/tmp/spec-a.md', 2], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2']], ['/tmp/spec-b.md', []]])}
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
        commentCounts={new Map([['/tmp/spec-a.md', 2], ['/tmp/spec-b.md', 1]])}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2']], ['/tmp/spec-b.md', ['c3']]])}
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

  it('Finish review with zero unsent comments POSTs to /finish with no prompt', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();

    const sessionAllSent: ReviewSession = {
      ...session,
      sentCommentIds: ['c1', 'c2'],
    };

    render(
      <ReviewBanner
        sessions={[sessionAllSent]}
        commentCounts={new Map([['/tmp/spec-a.md', 0], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', ['c2']]])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /finish review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_1/finish',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // No body (no prompt) when there are zero unsent comments
    const callInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(callInit.body).toBeUndefined();

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
        commentCounts={new Map([['/tmp/spec-a.md', 2], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', []]])}
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', ['c2']]])}
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 1]])}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', ['c2']]])}
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
      expect(showToast).toHaveBeenCalledWith('Review cancelled');
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', []]])}
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', []]])}
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
    expect((showToast.mock.calls[0][0] as string)).toContain('Cancel failed');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('Send batch calls onBatchSent with the sent comment IDs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onBatchSent = vi.fn();

    render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={new Map([['/tmp/spec-a.md', 2], ['/tmp/spec-b.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        onBatchSent={onBatchSent}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2']], ['/tmp/spec-b.md', ['c3']]])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      expect(onBatchSent).toHaveBeenCalledWith(['c1', 'c2', 'c3']);
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', []]])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ & finish/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect((showToast.mock.calls[0][0] as string)).toContain('Finish failed');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('Finish review with zero unsent comments calls /finish with no prompt body', async () => {
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
        commentCounts={new Map([['/tmp/spec-a.md', 1], ['/tmp/spec-b.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']], ['/tmp/spec-b.md', []]])}
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
    expect(callInit.body).toBeUndefined();

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
        commentIdsByFile={new Map([
          ['/tmp/spec-a.md', ['c1']],
          ['/tmp/spec-b.md', ['c2', 'c3']],
          ['/tmp/spec-c.md', ['c4']],
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send \d+ comment/i }));

    await waitFor(() => {
      // Only c1 from spec-a should be sent, not c2/c3/c4 from other files
      expect(onBatchSent).toHaveBeenCalledWith(['c1']);
    });
  });
});

describe('ReviewBanner — awaiting-reply state', () => {
  function renderBanner(overrides: Partial<Parameters<typeof ReviewBanner>[0]> = {}) {
    const defaultProps: Parameters<typeof ReviewBanner>[0] = {
      sessions: [
        {
          id: 'rev_test',
          filePaths: ['/tmp/a.md'],
          enableResolve: false,
          status: 'open',
          sentCommentIds: [],
          waitingForAgent: false,
          origin: 'user',
        },
      ],
      commentCounts: new Map([['/tmp/a.md', 0]]),
      onHandoffSuccess: () => {},
      onResolved: () => {},
      commentIdsByFile: new Map(),
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_x', commentIds: ['c1', 'c2', 'c3'], agentName: 'Claude', readyCount: 0 }],
      ]),
      onSendReplies: vi.fn(),
    };
    return { props: { ...defaultProps, ...overrides }, ...render(<ReviewBanner {...{ ...defaultProps, ...overrides }} />) };
  }

  it('shows "Claude has N questions" copy when asks are pending', () => {
    renderBanner();
    expect(screen.getByText(/has 3 questions/i)).not.toBeNull();
  });

  it('disables Send replies until all replies are ready', () => {
    renderBanner({
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_x', commentIds: ['c1', 'c2', 'c3'], agentName: 'Claude', readyCount: 1 }],
      ]),
    });
    const btn = screen.getByRole('button', { name: /Send replies/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Send replies once all replies are ready and triggers callback', () => {
    const onSendReplies = vi.fn();
    renderBanner({
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_x', commentIds: ['c1', 'c2', 'c3'], agentName: 'Claude', readyCount: 3 }],
      ]),
      onSendReplies,
    });
    const btn = screen.getByRole('button', { name: /Send replies/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onSendReplies).toHaveBeenCalledWith('rev_test', 'ask_x');
  });

  it('hides Send & finish but shows Send batch when there are unsent comments in awaiting-reply state', () => {
    renderBanner({
      commentIdsByFile: new Map([['/tmp/a.md', ['new-c1']]]),
    });
    // Send batch should appear (there are unsent comments)
    expect(screen.getByRole('button', { name: /Send \d+ comment/i })).not.toBeNull();
    // Send & finish should not appear
    expect(screen.queryByRole('button', { name: /Send \d+ & finish/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Cancel review/i })).not.toBeNull();
  });

  it('hides Send batch in awaiting-reply state when there are no unsent comments', () => {
    renderBanner({
      commentIdsByFile: new Map(),
    });
    expect(screen.queryByRole('button', { name: /Send \d+ comment/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Cancel review/i })).not.toBeNull();
  });

  it('falls back to waiting-for-batch state when ask has no commentIds', () => {
    renderBanner({
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_x', commentIds: [], agentName: 'Claude', readyCount: 0 }],
      ]),
    });
    // Send replies should NOT appear; the existing batch state should.
    expect(screen.queryByRole('button', { name: /Send replies/i })).toBeNull();
  });

  it('shows queued toast when server responds with queued:true', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, queued: true }) } as Response);
    const showToast = vi.fn();
    renderBanner({
      commentIdsByFile: new Map([['/tmp/a.md', ['new-c1']]]),
      showToast,
    });
    fireEvent.click(screen.getByRole('button', { name: /Send \d+ comment/i }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect((showToast.mock.calls[0][0] as string)).toContain('Queued');
    expect((showToast.mock.calls[0][0] as string)).toContain('will send after your reply');
  });

  it('disables Send replies during an in-flight call', async () => {
    let resolveSend: () => void = () => {};
    const onSendReplies = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolveSend = r; }),
    );
    renderBanner({
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_x', commentIds: ['c1', 'c2', 'c3'], agentName: 'Claude', readyCount: 3 }],
      ]),
      onSendReplies,
    });
    const btn = screen.getByRole('button', { name: /Send replies/i });
    fireEvent.click(btn);
    // Banner is now in busy state.
    expect((screen.getByRole('button', { name: /Send replies/i }) as HTMLButtonElement).disabled).toBe(true);
    resolveSend();
  });

  it('shows Release agent button when ask is pending', () => {
    renderBanner();
    expect(screen.getByRole('button', { name: /release agent/i })).not.toBeNull();
  });

  it('POSTs to /release endpoint when Release agent is clicked', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    renderBanner({
      pendingAsksBySession: new Map([
        ['rev_test', { askId: 'ask_X', commentIds: ['c1'], agentName: 'Claude', readyCount: 0 }],
      ]),
    });
    fireEvent.click(screen.getByRole('button', { name: /release agent/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/asks\/ask_X\/release$/);
    expect(init.method).toBe('POST');
  });

  it('shows confirmation toast after Release agent succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const showToast = vi.fn();
    renderBanner({ showToast });
    fireEvent.click(screen.getByRole('button', { name: /release agent/i }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect((showToast.mock.calls[0][0] as string).toLowerCase()).toContain('released');
  });

  it('shows error toast when Release agent POST returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Ask not found' }),
    } as Response);
    const showToast = vi.fn();
    renderBanner({ showToast });
    fireEvent.click(screen.getByRole('button', { name: /release agent/i }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect((showToast.mock.calls[0][0] as string).toLowerCase()).toContain('release failed');
  });

  it('disables Release agent button while the request is in flight', async () => {
    let resolveRelease: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((r) => { resolveRelease = r; }),
    );
    renderBanner();
    const btn = screen.getByRole('button', { name: /release agent/i });
    fireEvent.click(btn);
    expect((screen.getByRole('button', { name: /release agent/i }) as HTMLButtonElement).disabled).toBe(true);
    resolveRelease({ ok: true, json: async () => ({ ok: true }) } as Response);
  });
});

describe('ReviewBanner — agent-reviewing state', () => {
  const agentSession: ReviewSession = {
    id: 'rev_agent',
    filePaths: ['/tmp/spec-a.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'agent',
    lastAgentActivityAt: null,
  };

  it('renders the active agent review banner with no count before any comments arrive', () => {
    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', []]])}
      />,
    );

    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('is reviewing');
    // No spinner before any activity (lastAgentActivityAt is null)
    expect(banner.querySelector('[role="status"]')).toBeNull();
    // Static dot is shown instead
    expect(banner.querySelector('[aria-hidden]')).not.toBeNull();
    // No count phrase before any comments arrive
    expect(banner.textContent?.toLowerCase()).not.toContain('comments so far');
    // Dismiss button is present from the start
    expect(screen.getByRole('button', { name: /dismiss/i })).not.toBeNull();
  });

  it('renders the active agent review banner with count when comments exist', () => {
    // Recent activity — spinner should show
    const recentActivitySession: ReviewSession = {
      ...agentSession,
      lastAgentActivityAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago
    };
    render(
      <ReviewBanner
        sessions={[recentActivitySession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 3]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2', 'c3']]])}
        agentNamesBySession={new Map([['rev_agent', 'Claude']])}
      />,
    );

    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('is reviewing');
    // Spinner is present for recent activity
    expect(banner.querySelector('[role="status"]')).not.toBeNull();
    // Comment count is shown
    expect(banner.textContent).toContain('3 comments so far');
    expect(screen.getByRole('button', { name: /dismiss/i })).not.toBeNull();
  });

  it('shows spinner when lastAgentActivityAt is recent (within 30s)', () => {
    const activeSession: ReviewSession = {
      ...agentSession,
      lastAgentActivityAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago
    };
    render(
      <ReviewBanner
        sessions={[activeSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']]])}
      />,
    );
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows static dot when lastAgentActivityAt is stale (older than 30s)', () => {
    const staleSession: ReviewSession = {
      ...agentSession,
      lastAgentActivityAt: new Date(Date.now() - 60_000).toISOString(), // 60s ago
    };
    render(
      <ReviewBanner
        sessions={[staleSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']]])}
      />,
    );
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).toBeNull();
    expect(banner.querySelector('[aria-hidden]')).not.toBeNull();
  });

  it('shows static dot when lastAgentActivityAt is null (no activity yet)', () => {
    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', []]])}
      />,
    );
    const banner = screen.getByTestId('review-banner');
    expect(banner.querySelector('[role="status"]')).toBeNull();
    expect(banner.querySelector('[aria-hidden]')).not.toBeNull();
  });

  it('uses "Agent" fallback name when agentNamesBySession is absent', () => {
    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 2]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1', 'c2']]])}
      />,
    );

    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).toContain('agent is reviewing');
  });

  it('does not show the agent-reviewing banner for user-origin sessions', () => {
    const userSession: ReviewSession = {
      ...agentSession,
      id: 'rev_user',
      origin: 'user',
    };

    render(
      <ReviewBanner
        sessions={[userSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', []]])}
      />,
    );

    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).not.toContain('is reviewing');
  });

  it('pending-ask banner takes priority over agent-reviewing banner', () => {
    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 0]])}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIdsByFile={new Map([['/tmp/spec-a.md', []]])}
        pendingAsksBySession={new Map([
          ['rev_agent', { askId: 'ask_1', commentIds: ['c1'], agentName: 'Claude', readyCount: 0 }],
        ])}
        onSendReplies={vi.fn()}
      />,
    );

    // Should show the pending-ask state, not the agent-reviewing state
    expect(screen.getByText(/has 1 question/i)).not.toBeNull();
    const banner = screen.getByTestId('review-banner');
    expect(banner.textContent?.toLowerCase()).not.toContain('is reviewing');
  });

  it('Dismiss POSTs to /abort and calls onResolved', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const onResolved = vi.fn();

    render(
      <ReviewBanner
        sessions={[agentSession]}
        commentCounts={new Map([['/tmp/spec-a.md', 0]])}
        agentCommentCounts={new Map([['/tmp/spec-a.md', 1]])}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        commentIdsByFile={new Map([['/tmp/spec-a.md', ['c1']]])}
        agentNamesBySession={new Map([['rev_agent', 'Gemini']])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review-sessions/rev_agent/abort',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(onResolved).toHaveBeenCalled();
  });

  it('user-origin session still renders the "Agent is waiting" banner (regression guard)', () => {
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
