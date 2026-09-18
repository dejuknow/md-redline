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
});
