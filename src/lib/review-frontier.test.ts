import { describe, it, expect } from 'vitest';
import { shouldAdvanceFrontier, formatReferenceLabel } from './review-frontier';

const base = {
  resolveEnabled: true,
  hasReference: true,
  prevOpenCount: 2,
  openCount: 0,
  alreadyAdvanced: false,
  fileChanged: false,
  resolveEnabledChanged: false,
};

describe('shouldAdvanceFrontier', () => {
  it('advances on a genuine >0 to 0 crossing', () => {
    expect(shouldAdvanceFrontier(base)).toBe(true);
  });
  it('does not advance when resolve is disabled', () => {
    expect(shouldAdvanceFrontier({ ...base, resolveEnabled: false })).toBe(false);
  });
  it('does not advance without a reference', () => {
    expect(shouldAdvanceFrontier({ ...base, hasReference: false })).toBe(false);
  });
  it('does not advance while open comments remain', () => {
    expect(shouldAdvanceFrontier({ ...base, openCount: 1 })).toBe(false);
  });
  it('does not advance when there was no prior open comment (no crossing)', () => {
    expect(shouldAdvanceFrontier({ ...base, prevOpenCount: 0 })).toBe(false);
  });
  it('does not advance twice for the same episode', () => {
    expect(shouldAdvanceFrontier({ ...base, alreadyAdvanced: true })).toBe(false);
  });
  it('does not advance on the render where the active file just changed', () => {
    expect(shouldAdvanceFrontier({ ...base, fileChanged: true })).toBe(false);
  });
  it('does not advance when the resolve setting just changed', () => {
    expect(shouldAdvanceFrontier({ ...base, resolveEnabledChanged: true })).toBe(false);
  });
});

describe('formatReferenceLabel', () => {
  it('labels a handoff reference', () => {
    const at = new Date('2026-07-12T15:14:00').getTime();
    expect(formatReferenceLabel({ origin: 'handoff', capturedAt: at })).toMatch(/^Since last handoff, /);
  });
  it('labels a review reference', () => {
    const at = new Date('2026-07-12T15:14:00').getTime();
    expect(formatReferenceLabel({ origin: 'review', capturedAt: at })).toMatch(/^Since last review, /);
  });
});
