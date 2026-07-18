import { describe, expect, it } from 'vitest';
import { resolveCollisions, MAX_LIFT, type MarginEntry } from './margin-layout';

function entry(id: string, anchorTop: number | null, height = 100): MarginEntry {
  return { id, anchorTop, height };
}

/** Assert no two cards overlap and none sits above the top floor. */
function assertNoOverlap(entries: MarginEntry[], tops: Map<string, number>, gap = 8) {
  const placed = entries
    .map((e) => ({ top: tops.get(e.id)!, bottom: tops.get(e.id)! + e.height }))
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < placed.length; i++) {
    expect(placed[i].top).toBeGreaterThanOrEqual(placed[i - 1].bottom + gap);
  }
  for (const p of placed) expect(p.top).toBeGreaterThanOrEqual(0);
}

/** Assert no anchored card sits more than MAX_LIFT above its own anchor. */
function assertLiftCapped(entries: MarginEntry[], tops: Map<string, number>) {
  for (const e of entries) {
    if (e.anchorTop === null) continue;
    expect(tops.get(e.id)!).toBeGreaterThanOrEqual(e.anchorTop - MAX_LIFT);
  }
}

describe('resolveCollisions', () => {
  it('passes through non-overlapping cards at their anchors', () => {
    const entries = [entry('a', 0), entry('b', 300), entry('c', 700)];
    const tops = resolveCollisions(entries, null);
    expect(tops.get('a')).toBe(0);
    expect(tops.get('b')).toBe(300);
    expect(tops.get('c')).toBe(700);
    assertNoOverlap(entries, tops);
  });

  it('pushes overlapping cards down in a chain', () => {
    const entries = [entry('a', 100), entry('b', 120), entry('c', 140)];
    const tops = resolveCollisions(entries, null);
    expect(tops.get('a')).toBe(100);
    expect(tops.get('b')).toBe(208); // 100 + 100 + 8
    expect(tops.get('c')).toBe(316); // 208 + 100 + 8
    assertNoOverlap(entries, tops);
  });

  it('sorts by anchor position regardless of array order', () => {
    const entries = [entry('late', 500), entry('early', 50)];
    const tops = resolveCollisions(entries, null);
    expect(tops.get('early')).toBe(50);
    expect(tops.get('late')).toBe(500);
  });

  it('pins the active card at its anchor and pushes the card above upward', () => {
    // Without priority, b would be pushed to 208. With b active, b pins at 120
    // and a must move up to 120 - 100 - 8 = 12.
    const entries = [entry('a', 100), entry('b', 120)];
    const tops = resolveCollisions(entries, 'b');
    expect(tops.get('b')).toBe(120);
    expect(tops.get('a')).toBe(12);
    assertNoOverlap(entries, tops);
    assertLiftCapped(entries, tops);
  });

  it('shifts the active card down when cards above hit the floor', () => {
    // a wants 0 already; b active wants 40 but a occupies 0..100, so even at
    // the floor a cannot free room: b lands at 108 (best effort), not 40.
    const entries = [entry('a', 0), entry('b', 40)];
    const tops = resolveCollisions(entries, 'b');
    expect(tops.get('a')).toBe(0);
    expect(tops.get('b')).toBe(108);
    assertNoOverlap(entries, tops);
  });

  it('stacks orphans in a block at the top and floors anchored cards below it', () => {
    const entries = [entry('orphan1', null, 60), entry('orphan2', null, 60), entry('a', 10)];
    const tops = resolveCollisions(entries, null);
    expect(tops.get('orphan1')).toBe(0);
    expect(tops.get('orphan2')).toBe(68); // 60 + 8
    expect(tops.get('a')).toBe(136); // orphan block bottom 128 + 8
    assertNoOverlap(entries, tops);
  });

  it('upward push respects the orphan-block floor', () => {
    // Orphan occupies 0..60, floor = 68. Active b pins at 200; a wants
    // min(180, 200 - 100 - 8) = 92, which is above the floor 68, fine.
    const entries = [entry('o', null, 60), entry('a', 180), entry('b', 200)];
    const tops = resolveCollisions(entries, 'b');
    expect(tops.get('o')).toBe(0);
    expect(tops.get('b')).toBe(200);
    expect(tops.get('a')).toBe(92);
    assertNoOverlap(entries, tops);
    assertLiftCapped(entries, tops);
  });

  it('respects a custom gap', () => {
    const entries = [entry('a', 0), entry('b', 0)];
    const tops = resolveCollisions(entries, null, 20);
    expect(tops.get('a')).toBe(0);
    expect(tops.get('b')).toBe(120); // 100 + 20
  });

  it('returns an empty map for no entries', () => {
    expect(resolveCollisions([], null).size).toBe(0);
  });

  it('never overlaps when several cards above the active card hit the floor', () => {
    const entries = [entry('c0', 0), entry('c1', 0), entry('c2', 0)];
    const tops = resolveCollisions(entries, 'c2');
    expect(tops.get('c0')).toBe(0);
    expect(tops.get('c1')).toBe(108);
    expect(tops.get('c2')).toBe(216);
    assertNoOverlap(entries, tops);
  });

  it('floor-blocked chains compress to the floor and shift the active card by the overflow', () => {
    const entries = [entry('o', null, 60), entry('a', 70), entry('b', 80), entry('c', 90)];
    const tops = resolveCollisions(entries, 'c');
    expect(tops.get('o')).toBe(0);
    expect(tops.get('a')).toBe(68);
    expect(tops.get('b')).toBe(176);
    expect(tops.get('c')).toBe(284);
    assertNoOverlap(entries, tops);
    assertLiftCapped(entries, tops);
  });

  it('upward packing succeeds when there is room for the whole chain', () => {
    const entries = [entry('a', 100, 50), entry('b', 200, 50), entry('c', 210, 50)];
    const tops = resolveCollisions(entries, 'c');
    expect(tops.get('a')).toBe(94);
    expect(tops.get('b')).toBe(152);
    expect(tops.get('c')).toBe(210);
    assertNoOverlap(entries, tops);
    assertLiftCapped(entries, tops);
  });

  it('caps upward lift and shifts the pinned card down by the residual', () => {
    // Anchors 200/250/260, active c. Without a cap, a was dragged to 68
    // (132px above its anchor). With MAX_LIFT=96: a bottoms out at 104,
    // b at 212, and the pinned card c absorbs the residual by moving down.
    const entries = [entry('o', null, 60), entry('a', 200), entry('b', 250), entry('c', 260)];
    const tops = resolveCollisions(entries, 'c');
    expect(tops.get('o')).toBe(0);
    expect(tops.get('a')).toBe(104); // 200 - MAX_LIFT
    expect(tops.get('b')).toBe(212); // stacked below a
    expect(tops.get('c')).toBe(320); // pushed down past its 260 pin
    assertNoOverlap(entries, tops);
    assertLiftCapped(entries, tops);
  });
});
