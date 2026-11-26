import { describe, it, expect } from 'vitest';
import { pickHeaderSessions } from './header-session';
import type { ReviewSession } from '../hooks/useReviewSession';

function session(id: string, overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id,
    filePaths: [`/tmp/${id}.md`],
    enableResolve: false,
    status: 'open',
    sentCommentIds: [],
    waitingForAgent: false,
    origin: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const never = () => false;

describe('pickHeaderSessions', () => {
  it('returns null primary for no sessions', () => {
    expect(pickHeaderSessions([], new Map(), never)).toEqual({
      primary: null,
      others: [],
      heldEnded: false,
    });
  });

  it('prefers a session with pending questions', () => {
    const a = session('a', { origin: 'user' });
    const b = session('b');
    const c = session('c');
    const { primary } = pickHeaderSessions(
      [a, b, c],
      new Map([
        ['b', 0],
        ['c', 2],
      ]),
      (s) => s.id === 'a',
    );
    // Pending questions outrank a review that is ready to send.
    expect(primary?.id).toBe('c');
  });

  it('then a user session ready to send', () => {
    const a = session('a');
    const b = session('b', { origin: 'user' });
    const c = session('c', { origin: 'user' });
    const { primary } = pickHeaderSessions([a, b, c], new Map(), (s) => s.id === 'c');
    expect(primary?.id).toBe('c');
  });

  it('ignores readyToSend for an agent session', () => {
    const a = session('a', { origin: 'user' });
    const b = session('b');
    const { primary } = pickHeaderSessions([a, b], new Map(), (s) => s.id === 'b');
    expect(primary?.id).toBe('a');
  });

  it('keeps input order for the rest', () => {
    const a = session('a');
    const b = session('b', { origin: 'user' });
    const c = session('c');
    const { primary, others } = pickHeaderSessions([a, b, c], new Map(), never);
    expect(primary?.id).toBe('a');
    expect(others.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('others excludes the primary', () => {
    const a = session('a');
    const b = session('b');
    const c = session('c');
    const { primary, others } = pickHeaderSessions([a, b, c], new Map([['b', 1]]), never);
    expect(primary?.id).toBe('b');
    expect(others.map((s) => s.id)).toEqual(['a', 'c']);
  });

  describe('the shown review and the hold', () => {
    it('picks by priority when not held, even over the review shown last', () => {
      const a = session('a', { origin: 'user', waitingForAgent: true });
      const b = session('b', { origin: 'user' });
      // A was shown; its send went out, so only B is ready now.
      const { primary, others } = pickHeaderSessions([a, b], new Map(), (s) => s.id === 'b', {
        id: 'a',
      });
      expect(primary?.id).toBe('b');
      expect(others.map((s) => s.id)).toEqual(['a']);
    });

    it('a question elsewhere takes the row from a review ready to send when not held', () => {
      const a = session('a', { origin: 'user' });
      const b = session('b');
      const { primary } = pickHeaderSessions([a, b], new Map([['b', 1]]), (s) => s.id === 'a', {
        id: 'a',
      });
      expect(primary?.id).toBe('b');
    });

    it('ties keep input order rather than the review shown last', () => {
      const a = session('a');
      const b = session('b');
      const asks = new Map([
        ['a', 1],
        ['b', 1],
      ]);
      expect(pickHeaderSessions([a, b], asks, never, { id: 'b' }).primary?.id).toBe('a');
    });

    it('keeps the shown review while held, over a higher priority', () => {
      const a = session('a', { origin: 'user', waitingForAgent: true });
      const b = session('b', { origin: 'user' });
      const { primary, heldEnded } = pickHeaderSessions([a, b], new Map([['b', 2]]), never, {
        id: 'a',
        hold: true,
      });
      expect(primary?.id).toBe('a');
      expect(heldEnded).toBe(false);
    });

    it('a held review that ended gives the row to the next by priority and says so', () => {
      const b = session('b', { origin: 'user' });
      const c = session('c', { origin: 'user' });
      const { primary, heldEnded } = pickHeaderSessions([b, c], new Map(), (s) => s.id === 'c', {
        id: 'a',
        hold: true,
      });
      expect(primary?.id).toBe('c');
      expect(heldEnded).toBe(true);
    });

    it('a shown review that ended while not held is not reported as held', () => {
      const b = session('b');
      const { primary, heldEnded } = pickHeaderSessions([b], new Map(), never, { id: 'a' });
      expect(primary?.id).toBe('b');
      expect(heldEnded).toBe(false);
    });
  });
});
