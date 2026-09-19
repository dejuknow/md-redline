// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentBaselines, MAX_SEED_BYTES, type BaselineMeta } from './useAgentBaselines';
import type { DiffReference } from './useDiffSnapshot';

type FetchMock = ReturnType<typeof vi.fn>;

function mockServer(metas: BaselineMeta[], contents: Record<string, string>) {
  const fetchMock: FetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/baselines/content?path=')) {
      const path = decodeURIComponent(url.slice('/api/baselines/content?path='.length));
      const meta = metas.find((m) => m.path === path);
      if (!meta || !(path in contents)) {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
      }
      return new Response(JSON.stringify({ ...meta, content: contents[path] }), { status: 200 });
    }
    if (url === '/api/baselines') {
      return new Response(JSON.stringify({ baselines: metas }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeRefs(initial: Record<string, DiffReference> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getReference: (p: string) => map.get(p) ?? null,
    seedReference: vi.fn((p: string, ref: DiffReference) => {
      if (map.has(p)) return false;
      map.set(p, ref);
      return true;
    }),
  };
}

const contentCalls = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/baselines/content')).length;

describe('useAgentBaselines', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('seeds an open path whose server baseline is newer than the local reference', async () => {
    const fetchMock = mockServer(
      [{ path: '/a.md', capturedAt: 200, agentName: 'Claude', bytes: 3 }],
      { '/a.md': 'old' },
    );
    const refs = makeRefs();
    const onSeeded = vi.fn();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs, onSeeded }));

    await waitFor(() => expect(refs.seedReference).toHaveBeenCalledTimes(1));
    expect(refs.seedReference).toHaveBeenCalledWith('/a.md', {
      content: 'old',
      capturedAt: 200,
      origin: 'agent',
      agentName: 'Claude',
    });
    expect(onSeeded).toHaveBeenCalledWith('/a.md', expect.objectContaining({ origin: 'agent' }));
    expect(contentCalls(fetchMock)).toBe(1);
  });

  it('does not fetch content when the path already has a reference, even an older one', async () => {
    const fetchMock = mockServer([{ path: '/a.md', capturedAt: 100, bytes: 3 }], {
      '/a.md': 'old',
    });
    const refs = makeRefs({
      '/a.md': { content: 'mine', capturedAt: 50, origin: 'review' },
    });
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/baselines', expect.anything()),
    );
    expect(contentCalls(fetchMock)).toBe(0);
    expect(refs.seedReference).not.toHaveBeenCalled();
  });

  it('skips a copy above the seed size cap', async () => {
    const fetchMock = mockServer([{ path: '/a.md', capturedAt: 200, bytes: MAX_SEED_BYTES + 1 }], {
      '/a.md': 'old',
    });
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/baselines', expect.anything()),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(contentCalls(fetchMock)).toBe(0);
    expect(refs.seedReference).not.toHaveBeenCalled();
  });

  it('ignores baselines for paths that are not open', async () => {
    const fetchMock = mockServer([{ path: '/b.md', capturedAt: 200, bytes: 3 }], {
      '/b.md': 'old',
    });
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(contentCalls(fetchMock)).toBe(0);
  });

  it('seeds when a tab for a known baseline opens later', async () => {
    const fetchMock = mockServer([{ path: '/b.md', capturedAt: 200, bytes: 3 }], {
      '/b.md': 'old',
    });
    const refs = makeRefs();
    const { rerender } = renderHook(({ openPaths }) => useAgentBaselines({ openPaths, ...refs }), {
      initialProps: { openPaths: ['/a.md'] },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(contentCalls(fetchMock)).toBe(0);

    rerender({ openPaths: ['/a.md', '/b.md'] });
    await waitFor(() =>
      expect(refs.seedReference).toHaveBeenCalledWith('/b.md', expect.anything()),
    );
  });

  it('fetches content once per (path, capturedAt) across polls', async () => {
    const fetchMock = mockServer([{ path: '/a.md', capturedAt: 200, bytes: 3 }], {
      '/a.md': 'old',
    });
    // seedReference reports success but never actually stores, so
    // getReference keeps returning null: the only thing that can stop a
    // second fetch for the same (path, capturedAt) is the attempted set.
    const refs = {
      getReference: () => null,
      seedReference: vi.fn(() => true),
    };
    const { rerender } = renderHook(({ openPaths }) => useAgentBaselines({ openPaths, ...refs }), {
      initialProps: { openPaths: ['/a.md'] },
    });
    await waitFor(() => expect(refs.seedReference).toHaveBeenCalledTimes(1));

    // Force two more seed passes without a new baseline or a retry tick.
    rerender({ openPaths: ['/a.md', '/y.md'] });
    rerender({ openPaths: ['/a.md', '/y.md', '/z.md'] });

    expect(contentCalls(fetchMock)).toBe(1);
  });

  it('exposes the polled metadata', async () => {
    mockServer([{ path: '/a.md', capturedAt: 200, bytes: 3 }], {});
    const refs = makeRefs();
    const { result } = renderHook(() => useAgentBaselines({ openPaths: [], ...refs }));
    await waitFor(() => expect(result.current.baselines).toHaveLength(1));
  });

  it('does nothing when disabled', async () => {
    const fetchMock = mockServer([{ path: '/a.md', capturedAt: 200, bytes: 3 }], { '/a.md': 'x' });
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], enabled: false, ...refs }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still seeds when the open set changes while the content fetch is in flight', async () => {
    const metas: BaselineMeta[] = [{ path: '/a.md', capturedAt: 200, bytes: 3 }];
    let release: (() => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/baselines/content?path=')) {
        await new Promise<void>((r) => {
          release = r;
        });
        return new Response(JSON.stringify({ ...metas[0], content: 'old' }), { status: 200 });
      }
      return new Response(JSON.stringify({ baselines: metas }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const refs = makeRefs();
    const { rerender } = renderHook(({ openPaths }) => useAgentBaselines({ openPaths, ...refs }), {
      initialProps: { openPaths: ['/a.md'] },
    });
    await waitFor(() => expect(release).not.toBeNull());

    rerender({ openPaths: ['/a.md', '/b.md'] });
    await act(async () => {
      release!();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(refs.seedReference).toHaveBeenCalledWith(
      '/a.md',
      expect.objectContaining({ content: 'old' }),
    );
    expect(contentCalls(fetchMock)).toBe(1);
  });

  it('retries a content fetch that failed on the next poll', async () => {
    const metas: BaselineMeta[] = [{ path: '/a.md', capturedAt: 200, bytes: 3 }];
    let contentAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/baselines/content?path=')) {
        contentAttempts += 1;
        if (contentAttempts === 1) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ ...metas[0], content: 'old' }), { status: 200 });
      }
      return new Response(JSON.stringify({ baselines: metas }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));
    await waitFor(() => expect(contentAttempts).toBe(1));
    expect(refs.seedReference).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(refs.seedReference).toHaveBeenCalledTimes(1));
    expect(contentAttempts).toBe(2);
  });

  it('does not retry a content fetch that returns 403 (4xx is terminal)', async () => {
    const metas: BaselineMeta[] = [
      { path: '/a.md', capturedAt: 200, bytes: 3 },
      { path: '/b.md', capturedAt: 200, bytes: 3 },
    ];
    let aAttempts = 0;
    let bAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/baselines/content?path=')) {
        const path = decodeURIComponent(url.slice('/api/baselines/content?path='.length));
        if (path === '/a.md') {
          aAttempts += 1;
          return new Response('nope', { status: 403 });
        }
        bAttempts += 1;
        if (bAttempts === 1) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ ...metas[1], content: 'b content' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ baselines: metas }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md', '/b.md'], ...refs }));
    await waitFor(() => expect(aAttempts).toBe(1));
    await waitFor(() => expect(bAttempts).toBe(1));

    // The first poll's retry (from /b.md's 500) also gives a 403-released
    // key a chance to be retried, which is exactly what must not happen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(aAttempts).toBe(1);
    expect(bAttempts).toBe(2);
    expect(refs.seedReference).not.toHaveBeenCalledWith('/a.md', expect.anything());
  });

  it('does not re-render its consumer on a poll that finds nothing to retry', async () => {
    mockServer([{ path: '/a.md', capturedAt: 200, agentName: 'Claude', bytes: 3 }], {
      '/a.md': 'old',
    });
    const refs = makeRefs();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useAgentBaselines({ openPaths: ['/a.md'], ...refs });
    });

    await waitFor(() => expect(refs.seedReference).toHaveBeenCalledTimes(1));
    // Let one full poll cycle pass before measuring: React can still spend a
    // single incidental render settling the first post-mount interval tick
    // even when polled state does not change. What this test guards against
    // is a poll that finds nothing to retry costing a render forever, so it
    // measures the steady state after that one tick has passed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const rendersAfterSettle = renders;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(renders).toBe(rendersAfterSettle);
  });
});
