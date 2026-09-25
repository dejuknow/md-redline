import { describe, expect, it } from 'vitest';
import { BaselineStore, BASELINE_TTL_MS, MAX_BASELINES } from './baselines';

function makeStore(start = 1_000_000) {
  let t = start;
  const store = new BaselineStore({ now: () => t });
  return { store, tick: (ms: number) => (t += ms) };
}

describe('BaselineStore', () => {
  it('set returns metadata and get returns the full record', () => {
    const { store } = makeStore();
    const meta = store.set({ path: '/a.md', content: 'hello', agentName: 'Claude' });
    expect(meta).toEqual({ path: '/a.md', capturedAt: 1_000_000, agentName: 'Claude', bytes: 5 });
    expect(store.get('/a.md')).toEqual({ ...meta, content: 'hello' });
  });

  it('counts bytes, not characters', () => {
    const { store } = makeStore();
    expect(store.set({ path: '/a.md', content: 'é' }).bytes).toBe(2);
  });

  it('set on the same path replaces the older entry (newest wins)', () => {
    const { store, tick } = makeStore();
    store.set({ path: '/a.md', content: 'v1' });
    tick(10);
    store.set({ path: '/a.md', content: 'v2' });
    expect(store.get('/a.md')?.content).toBe('v2');
    expect(store.get('/a.md')?.capturedAt).toBe(1_000_010);
    expect(store.list()).toHaveLength(1);
  });

  it('list is metadata only, newest first', () => {
    const { store, tick } = makeStore();
    store.set({ path: '/a.md', content: 'a' });
    tick(1);
    store.set({ path: '/b.md', content: 'b' });
    const list = store.list();
    expect(list.map((m) => m.path)).toEqual(['/b.md', '/a.md']);
    expect(list[0]).not.toHaveProperty('content');
  });

  it('evicts the oldest entry once MAX_BASELINES is exceeded', () => {
    const { store, tick } = makeStore();
    for (let i = 0; i < MAX_BASELINES; i++) {
      store.set({ path: `/f${i}.md`, content: 'x' });
      tick(1);
    }
    store.set({ path: '/overflow.md', content: 'x' });
    expect(store.list()).toHaveLength(MAX_BASELINES);
    expect(store.get('/f0.md')).toBeNull();
    expect(store.get('/overflow.md')).not.toBeNull();
  });

  it('re-setting an existing path does not evict anyone', () => {
    const { store, tick } = makeStore();
    for (let i = 0; i < MAX_BASELINES; i++) {
      store.set({ path: `/f${i}.md`, content: 'x' });
      tick(1);
    }
    store.set({ path: '/f5.md', content: 'y' });
    expect(store.list()).toHaveLength(MAX_BASELINES);
    expect(store.get('/f0.md')).not.toBeNull();
  });

  it('expires entries older than BASELINE_TTL_MS on read', () => {
    const { store, tick } = makeStore();
    store.set({ path: '/a.md', content: 'a' });
    tick(BASELINE_TTL_MS - 1);
    expect(store.get('/a.md')).not.toBeNull();
    tick(2);
    expect(store.get('/a.md')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('omits agentName when none was given', () => {
    const { store } = makeStore();
    const meta = store.set({ path: '/a.md', content: 'a' });
    expect(meta).not.toHaveProperty('agentName');
  });

  it('has is true after set, false for an unknown path, false once expired', () => {
    const { store, tick } = makeStore();
    expect(store.has('/a.md')).toBe(false);
    store.set({ path: '/a.md', content: 'a' });
    expect(store.has('/a.md')).toBe(true);
    expect(store.has('/unknown.md')).toBe(false);
    tick(BASELINE_TTL_MS + 1);
    expect(store.has('/a.md')).toBe(false);
  });
});

describe('BaselineStore listener and restore (#138)', () => {
  function recording() {
    const events: string[] = [];
    return {
      events,
      listener: {
        restored: (e: { path: string }) => events.push(`restored ${e.path}`),
        stored: (e: { path: string }) => events.push(`stored ${e.path}`),
        removed: (p: string) => events.push(`removed ${p}`),
      },
    };
  }

  it('reports every copy stored, evicted, and expired, in order', () => {
    const { store, tick } = makeStore();
    const { events, listener } = recording();
    store.setListener(listener);
    for (let i = 0; i < MAX_BASELINES; i++) {
      store.set({ path: `/f${i}.md`, content: 'x' });
      tick(1);
    }
    store.set({ path: '/new.md', content: 'x' });
    expect(events.slice(-2)).toEqual(['removed /f0.md', 'stored /new.md']);
    tick(BASELINE_TTL_MS + 1);
    events.length = 0;
    store.list();
    expect(events).toHaveLength(MAX_BASELINES);
    expect(events.every((e) => e.startsWith('removed '))).toBe(true);
  });

  it('restore keeps the original capture time, so expiry counts from the real capture', () => {
    const { store, tick } = makeStore(5_000_000);
    store.restore([{ path: '/a.md', content: 'a', capturedAt: 1_000_000, bytes: 1 }]);
    expect(store.get('/a.md')?.capturedAt).toBe(1_000_000);
    tick(BASELINE_TTL_MS - 4_000_000);
    expect(store.get('/a.md')).not.toBeNull();
    tick(1);
    expect(store.get('/a.md')).toBeNull();
  });

  it('restore drops a copy already past its expiry, with room to spare', () => {
    const { store } = makeStore(BASELINE_TTL_MS * 2);
    const { events, listener } = recording();
    store.setListener(listener);
    store.restore([{ path: '/old.md', content: 'x', capturedAt: 0, bytes: 1 }]);
    expect(store.has('/old.md')).toBe(false);
    expect(events).toEqual(['restored /old.md', 'removed /old.md']);
  });

  it('restore drops what is expired or past the cap, oldest first, and reports each', () => {
    const { store } = makeStore(BASELINE_TTL_MS * 2);
    const { events, listener } = recording();
    store.setListener(listener);
    const now = BASELINE_TTL_MS * 2;
    const fresh = Array.from({ length: MAX_BASELINES + 1 }, (_, i) => ({
      path: `/f${i}.md`,
      content: 'x',
      capturedAt: now - 1_000 + i,
      bytes: 1,
    }));
    const stale = { path: '/stale.md', content: 'x', capturedAt: 0, bytes: 1 };
    store.restore([stale, ...fresh]);
    expect(store.list()).toHaveLength(MAX_BASELINES);
    expect(store.has('/f0.md')).toBe(false);
    expect(store.has(`/f${MAX_BASELINES}.md`)).toBe(true);
    expect(events.filter((e) => e.startsWith('removed')).sort()).toEqual([
      'removed /f0.md',
      'removed /stale.md',
    ]);
    expect(events.filter((e) => e.startsWith('restored'))).toHaveLength(MAX_BASELINES + 2);
  });
});
