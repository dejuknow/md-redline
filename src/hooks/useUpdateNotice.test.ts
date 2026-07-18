// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUpdateNotice } from './useUpdateNotice';

function stubFetch(version: { version: string; latest?: string }, prefs: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes('/api/version') ? version : prefs;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('useUpdateNotice', () => {
  it('exposes latest when newer and not dismissed', async () => {
    stubFetch({ version: '0.6.0', latest: '0.7.0' }, {});
    const { result } = renderHook(() => useUpdateNotice());
    await waitFor(() => expect(result.current.latest).toBe('0.7.0'));
  });

  it('stays hidden when the server reports no latest', async () => {
    const calls = stubFetch({ version: '0.6.0' }, {});
    const { result } = renderHook(() => useUpdateNotice());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(result.current.latest).toBeNull();
  });

  it('stays hidden when that version was already dismissed', async () => {
    stubFetch({ version: '0.6.0', latest: '0.7.0' }, { updateDismissedVersion: '0.7.0' });
    const { result } = renderHook(() => useUpdateNotice());
    // Give the effect a tick to settle, then assert it never showed.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.latest).toBeNull();
  });

  it('dismiss persists the version and clears the notice', async () => {
    const calls = stubFetch({ version: '0.6.0', latest: '0.7.0' }, {});
    const { result } = renderHook(() => useUpdateNotice());
    await waitFor(() => expect(result.current.latest).toBe('0.7.0'));
    act(() => result.current.dismiss());
    expect(result.current.latest).toBeNull();
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put!.init!.body))).toEqual({ updateDismissedVersion: '0.7.0' });
    });
  });
});
