// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentBaselines, type BaselineMeta } from './useAgentBaselines';
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
      const existing = map.get(p);
      if (existing && existing.capturedAt >= ref.capturedAt) return false;
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

  it('does not fetch content when the local reference is newer', async () => {
    const fetchMock = mockServer([{ path: '/a.md', capturedAt: 100, bytes: 3 }], {
      '/a.md': 'old',
    });
    const refs = makeRefs({
      '/a.md': { content: 'mine', capturedAt: 150, origin: 'review' },
    });
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/baselines', expect.anything()),
    );
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
    const refs = makeRefs();
    renderHook(() => useAgentBaselines({ openPaths: ['/a.md'], ...refs }));
    await waitFor(() => expect(refs.seedReference).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
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
});
