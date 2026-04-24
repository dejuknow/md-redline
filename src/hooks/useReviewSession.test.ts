// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewSession } from './useReviewSession';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useReviewSession', () => {
  it('polls /api/review-sessions every 5s and exposes open sessions', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 'rev_1',
            filePaths: ['/tmp/a.md'],
            enableResolve: false,
            status: 'open',
            sentCommentIds: [],
            waitingForAgent: false,
          },
        ],
      }),
    } as Response);

    const { result } = renderHook(() => useReviewSession());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('rev_1');

    expect(fetchMock).toHaveBeenCalledWith('/api/review-sessions', expect.any(Object));
  });

  it('sends an immediate heartbeat on mount and then every 10s', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/review-sessions')) {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'rev_1', filePaths: ['/tmp/a.md'], enableResolve: false, status: 'open', sentCommentIds: [], waitingForAgent: false },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    renderHook(() => useReviewSession());

    // Initial fetch — first poll finds the session, and an immediate
    // heartbeat fires right after (no waiting for the interval).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const heartbeatCallsAfterMount = fetchMock.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatCallsAfterMount).toBeGreaterThanOrEqual(1);

    // Advance 10s — interval should fire a second heartbeat.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    const heartbeatCallsAfterInterval = fetchMock.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatCallsAfterInterval).toBeGreaterThan(heartbeatCallsAfterMount);

    // Every heartbeat call must send the content-type header.
    const heartbeatCalls = fetchMock.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    );
    for (const [, init] of heartbeatCalls) {
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    }
  });

  it('keeps the same sessions reference across polls when the data is unchanged', async () => {
    // Every 5s poll that returns identical data must not produce a new array
    // reference. Downstream consumers (e.g. MarkdownViewer) re-run layout
    // effects on reference change, which blows away the DOM and kills any
    // in-progress native text selection.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 'rev_1',
            filePaths: ['/tmp/a.md'],
            enableResolve: false,
            status: 'open',
            sentCommentIds: [],
            waitingForAgent: false,
          },
        ],
      }),
    } as Response);

    const { result } = renderHook(() => useReviewSession());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstSessions = result.current.sessions;
    expect(firstSessions).toHaveLength(1);

    // Advance through several polls with identical data.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        for (let j = 0; j < 5; j++) await Promise.resolve();
      });
      expect(result.current.sessions).toBe(firstSessions);
    }
  });

  it('keeps the same sessions reference across empty polls', async () => {
    // Even when there are no sessions, the poll must not churn the reference —
    // a new empty array every 5s still triggers a re-render cascade.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    } as Response);

    const { result } = renderHook(() => useReviewSession());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstSessions = result.current.sessions;

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        for (let j = 0; j < 5; j++) await Promise.resolve();
      });
      expect(result.current.sessions).toBe(firstSessions);
    }
  });

  it('updates sessions reference when the data actually changes', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/review-sessions') {
        pollCount += 1;
        const sentCommentIds = pollCount >= 2 ? ['c1'] : [];
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                id: 'rev_1',
                filePaths: ['/tmp/a.md'],
                enableResolve: false,
                status: 'open',
                sentCommentIds,
                waitingForAgent: false,
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    const { result } = renderHook(() => useReviewSession());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const first = result.current.sessions;
    expect(first[0].sentCommentIds).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      for (let j = 0; j < 5; j++) await Promise.resolve();
    });

    expect(result.current.sessions).not.toBe(first);
    expect(result.current.sessions[0].sentCommentIds).toEqual(['c1']);
  });

  it('re-polls the session list when a heartbeat returns 404 (session swept server-side)', async () => {
    // First poll: session is open. Heartbeat returns 404 (server swept it).
    // Second poll must fire right after, returning an empty list so the
    // banner drops without waiting for the 5s interval.
    let pollCount = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/review-sessions')) {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                { id: 'rev_1', filePaths: ['/tmp/a.md'], enableResolve: false, status: 'open', sentCommentIds: [], waitingForAgent: false },
              ],
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ sessions: [] }),
        } as Response;
      }
      if (url.endsWith('/rev_1/heartbeat')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Session not found' }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    const { result } = renderHook(() => useReviewSession());

    // Let the initial poll + heartbeat + refresh poll all flush.
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    });

    // The hook should have called the list endpoint at least twice: the
    // initial poll, then the refresh triggered by the 404 heartbeat.
    const listCalls = fetchMock.mock.calls.filter(([url]) =>
      typeof url === 'string' && url === '/api/review-sessions',
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    // And the final sessions state should be empty (since the refresh poll
    // returned an empty list).
    expect(result.current.sessions).toEqual([]);
  });
});
