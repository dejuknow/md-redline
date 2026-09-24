// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { findActiveSessionForFile, useReviewSession, type ReviewSession } from './useReviewSession';

function mkSession(overrides: Partial<ReviewSession>): ReviewSession {
  return {
    id: 'rev_x',
    filePaths: ['/tmp/a.md'],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

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
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    renderHook(() => useReviewSession(['/tmp/a.md']));

    // Initial fetch — first poll finds the session, and an immediate
    // heartbeat fires right after (no waiting for the interval).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const heartbeatCallsAfterMount = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatCallsAfterMount).toBeGreaterThanOrEqual(1);

    // Advance 10s — interval should fire a second heartbeat.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    const heartbeatCallsAfterInterval = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatCallsAfterInterval).toBeGreaterThan(heartbeatCallsAfterMount);

    // Every heartbeat call must send the content-type header.
    const heartbeatCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    );
    for (const [, init] of heartbeatCalls) {
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    }
  });

  it('fires an immediate heartbeat when the page is restored from bfcache', async () => {
    // Backgrounded tabs come off-heartbeat under Chrome throttling. When
    // the user returns and the page is restored from bfcache, we want to
    // refresh the server-side lease immediately rather than wait up to
    // HEARTBEAT_INTERVAL_MS for the next interval tick.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/review-sessions')) {
        return {
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
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    renderHook(() => useReviewSession(['/tmp/a.md']));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const heartbeatsAfterMount = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;

    // Simulate bfcache restore. Real PageTransitionEvent isn't available in
    // jsdom, but the listener only reads the `persisted` field.
    await act(async () => {
      const evt = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(evt, 'persisted', { value: true });
      window.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
    });

    const heartbeatsAfterPageShow = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatsAfterPageShow).toBeGreaterThan(heartbeatsAfterMount);

    // A non-bfcache pageshow (persisted=false, e.g. normal navigation)
    // must NOT fire an extra heartbeat — the on-mount path already covers
    // that case.
    const before = heartbeatsAfterPageShow;
    await act(async () => {
      const evt = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(evt, 'persisted', { value: false });
      window.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
    });
    const heartbeatsAfterNonBfcacheShow = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/rev_1/heartbeat'),
    ).length;
    expect(heartbeatsAfterNonBfcacheShow).toBe(before);
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

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

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

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

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

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

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

  it('exposes session.origin from GET /api/review-sessions response', async () => {
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
            origin: 'agent',
          },
        ],
      }),
    } as Response);

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].origin).toBe('agent');
  });

  describe('heartbeats only the sessions this tab is showing (#114)', () => {
    // Two reviews on unrelated files, as in the issue's repro.
    function serveTwoSessions() {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/review-sessions')) {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                mkSession({ id: 'rev_a', filePaths: ['/tmp/a.md'] }),
                mkSession({ id: 'rev_ab', filePaths: ['/tmp/b.md', '/tmp/c.md'] }),
              ],
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      });
    }
    const beats = (id: string) =>
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.endsWith(`/${id}/heartbeat`),
      ).length;
    const flush = async () => {
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    };

    it('never renews a session on a file this tab does not have open', async () => {
      serveTwoSessions();
      renderHook(() => useReviewSession(['/tmp/a.md']));
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });

      expect(beats('rev_a')).toBeGreaterThanOrEqual(2);
      expect(beats('rev_ab')).toBe(0);
    });

    it('renews a multi-file session when any one of its files is open', async () => {
      serveTwoSessions();
      renderHook(() => useReviewSession(['/tmp/c.md']));
      await flush();

      expect(beats('rev_ab')).toBeGreaterThanOrEqual(1);
      expect(beats('rev_a')).toBe(0);
    });

    it('starts renewing a session once its file is opened', async () => {
      serveTwoSessions();
      const { rerender } = renderHook(({ files }) => useReviewSession(files), {
        initialProps: { files: ['/tmp/a.md'] as string[] },
      });
      await flush();
      expect(beats('rev_ab')).toBe(0);

      rerender({ files: ['/tmp/a.md', '/tmp/b.md'] });
      await flush();
      expect(beats('rev_ab')).toBeGreaterThanOrEqual(1);
    });

    it('stops renewing a session once its file is closed', async () => {
      serveTwoSessions();
      const { rerender } = renderHook(({ files }) => useReviewSession(files), {
        initialProps: { files: ['/tmp/a.md', '/tmp/b.md'] as string[] },
      });
      await flush();
      const whileOpen = beats('rev_ab');
      expect(whileOpen).toBeGreaterThanOrEqual(1);

      rerender({ files: ['/tmp/a.md'] });
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });

      expect(beats('rev_ab')).toBe(whileOpen);
    });

    it('shows only the sessions it keeps alive, so the banner never lists one it lets expire', async () => {
      serveTwoSessions();
      const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));
      await flush();

      expect(result.current.sessions.map((s) => s.id)).toEqual(['rev_a', 'rev_ab']);
      expect(result.current.shownSessions.map((s) => s.id)).toEqual(['rev_a']);
    });

    it('keeps renewing the rest of the round when one session is gone', async () => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/review-sessions')) {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                mkSession({ id: 'rev_gone', filePaths: ['/tmp/a.md'] }),
                mkSession({ id: 'rev_ok', filePaths: ['/tmp/a.md'] }),
              ],
            }),
          } as Response;
        }
        if (url.endsWith('/rev_gone/heartbeat')) {
          return { ok: false, status: 404, json: async () => ({}) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      });
      renderHook(() => useReviewSession(['/tmp/a.md']));
      await flush();

      expect(beats('rev_gone')).toBeGreaterThanOrEqual(1);
      expect(beats('rev_ok')).toBeGreaterThanOrEqual(1);
    });

    it('does not restart heartbeats when only a session it does not show changes', async () => {
      // An agent posting to a review on a file not open here changes that
      // session on every poll. A restart fires an immediate heartbeat, so
      // this would double the rate.
      let poll = 0;
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/review-sessions')) {
          poll += 1;
          return {
            ok: true,
            json: async () => ({
              sessions: [
                mkSession({ id: 'rev_a', filePaths: ['/tmp/a.md'] }),
                mkSession({
                  id: 'rev_ab',
                  filePaths: ['/tmp/b.md'],
                  lastAgentActivityAt: `2026-01-01T00:00:0${poll}.000Z`,
                }),
              ],
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      });
      renderHook(() => useReviewSession(['/tmp/a.md']));
      await flush();
      const afterMount = beats('rev_a');

      // Three polls (5s apart) that each change rev_ab; one 10s interval tick.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          vi.advanceTimersByTime(5_000);
          for (let j = 0; j < 5; j++) await Promise.resolve();
        });
      }

      expect(beats('rev_a')).toBe(afterMount + 1);
    });

    it('does not restart heartbeats when the same files arrive as a new array', async () => {
      // App rebuilds the list from tabs on every edit, since tabs carry their
      // text. A restart fires an immediate heartbeat, so it would be one per
      // keystroke.
      serveTwoSessions();
      const { rerender } = renderHook(({ files }) => useReviewSession(files), {
        initialProps: { files: ['/tmp/a.md'] as string[] },
      });
      await flush();
      const afterMount = beats('rev_a');

      for (let i = 0; i < 5; i++) {
        rerender({ files: ['/tmp/a.md', '/tmp/a.md'] });
        await flush();
      }

      expect(beats('rev_a')).toBe(afterMount);
    });
  });

  describe('findActiveSessionForFile', () => {
    it('returns null when no filePath provided', () => {
      expect(findActiveSessionForFile([mkSession({})], null)).toBeNull();
    });

    it('returns null when no session matches the file', () => {
      const sessions = [mkSession({ filePaths: ['/tmp/other.md'] })];
      expect(findActiveSessionForFile(sessions, '/tmp/a.md')).toBeNull();
    });

    it('returns the single matching session', () => {
      const session = mkSession({ id: 'rev_1' });
      expect(findActiveSessionForFile([session], '/tmp/a.md')).toBe(session);
    });

    it('prefers agent-origin over user-origin when both match', () => {
      const userSession = mkSession({ id: 'rev_user', origin: 'user' });
      const agentSession = mkSession({ id: 'rev_agent', origin: 'agent' });
      expect(findActiveSessionForFile([userSession, agentSession], '/tmp/a.md')).toBe(agentSession);
      // Order doesn't matter.
      expect(findActiveSessionForFile([agentSession, userSession], '/tmp/a.md')).toBe(agentSession);
    });

    it('within same origin, prefers the most recently created session', () => {
      const older = mkSession({ id: 'rev_old', createdAt: '2026-01-01T00:00:00Z' });
      const newer = mkSession({ id: 'rev_new', createdAt: '2026-05-01T00:00:00Z' });
      expect(findActiveSessionForFile([older, newer], '/tmp/a.md')).toBe(newer);
      expect(findActiveSessionForFile([newer, older], '/tmp/a.md')).toBe(newer);
    });

    it('treats invalid createdAt as oldest (0)', () => {
      const withDate = mkSession({ id: 'rev_dated', createdAt: '2026-05-01T00:00:00Z' });
      const invalid = mkSession({ id: 'rev_invalid', createdAt: 'not-a-date' });
      expect(findActiveSessionForFile([invalid, withDate], '/tmp/a.md')).toBe(withDate);
      expect(findActiveSessionForFile([withDate, invalid], '/tmp/a.md')).toBe(withDate);
    });

    it('filters out non-open sessions even when they match the file', () => {
      const open = mkSession({ id: 'rev_open', status: 'open' });
      const done = mkSession({ id: 'rev_done', status: 'done', origin: 'agent' });
      // The terminal agent session is more "recent" but must be skipped.
      expect(findActiveSessionForFile([done, open], '/tmp/a.md')).toBe(open);
    });
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

    const { result } = renderHook(() => useReviewSession(['/tmp/a.md']));

    // Let the initial poll + heartbeat + refresh poll all flush.
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    });

    // The hook should have called the list endpoint at least twice: the
    // initial poll, then the refresh triggered by the 404 heartbeat.
    const listCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url === '/api/review-sessions',
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    // And the final sessions state should be empty (since the refresh poll
    // returned an empty list).
    expect(result.current.sessions).toEqual([]);
  });
});
