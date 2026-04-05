import { describe, it, expect } from 'vitest';
import { getEffectiveStatus } from './types';
import type { MdComment } from './types';

function makeComment(overrides: Partial<MdComment> = {}): MdComment {
  return {
    id: 'test-id',
    anchor: 'some text',
    text: 'a comment',
    author: 'User',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getEffectiveStatus', () => {
  it("returns 'open' when status is 'open'", () => {
    expect(getEffectiveStatus(makeComment({ status: 'open' }))).toBe('open');
  });

  it("returns 'resolved' when status is 'resolved'", () => {
    expect(getEffectiveStatus(makeComment({ status: 'resolved' }))).toBe('resolved');
  });

  it("returns 'resolved' when status is 'accepted' (legacy backward compat)", () => {
    const comment = makeComment();
    // Cast to bypass type checking since 'accepted' is a legacy value
    (comment as unknown as Record<string, unknown>).status = 'accepted';
    expect(getEffectiveStatus(comment)).toBe('resolved');
  });

  it("returns 'resolved' when resolved boolean is true (legacy)", () => {
    expect(getEffectiveStatus(makeComment({ resolved: true }))).toBe('resolved');
  });

  it("returns 'open' when no status and no resolved field", () => {
    expect(getEffectiveStatus(makeComment())).toBe('open');
  });

  it("returns 'open' when status is undefined and resolved is false", () => {
    expect(getEffectiveStatus(makeComment({ status: undefined, resolved: false }))).toBe('open');
  });
});
