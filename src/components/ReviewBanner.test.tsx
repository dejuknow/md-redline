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
};

describe('ReviewBanner', () => {
  it('renders the file list when sessions are present', () => {
    const { container } = render(
      <ReviewBanner
        sessions={[session]}
        commentCounts={new Map([['/tmp/spec-a.md', 2], ['/tmp/spec-b.md', 0]])}
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIds={['c1', 'c2']}
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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIds={[]}
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
        enableResolve={false}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1', 'c2', 'c3']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send batch/i }));

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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        commentIds={['c1', 'c2']}
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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIds={['c1']}
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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIds={['c1', 'c2']}
      />,
    );

    const batchButton = screen.getByRole('button', { name: /send batch/i });
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
        enableResolve={false}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1', 'c2']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send & finish/i }));

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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={[]}
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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        commentIds={['c1']}
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
        enableResolve={false}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send batch/i }));

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
        enableResolve={false}
        onHandoffSuccess={onHandoffSuccess}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send batch/i }));

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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={[]}
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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={() => {}}
        onBatchSent={onBatchSent}
        commentIds={['c1', 'c2', 'c3']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send batch/i }));

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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send & finish/i }));

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
        enableResolve={false}
        onHandoffSuccess={() => {}}
        onResolved={onResolved}
        showToast={showToast}
        commentIds={['c1']}
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
});
