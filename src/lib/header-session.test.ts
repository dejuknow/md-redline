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
    expect(pickHeaderSessions([], new Map(), never)).toEqual({ primary: null, others: [] });
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

  describe('keeps the shown review steady', () => {
    it('a send on A leaves A shown while it waits on the agent, even with B ready', () => {
      const a = session('a', { origin: 'user', waitingForAgent: true });
      const b = session('b', { origin: 'user' });
      // A was shown and ready; its send went out, so only B is ready now.
      const { primary, others } = pickHeaderSessions([a, b], new Map(), (s) => s.id === 'b', {
        id: 'a',
      });
      expect(primary?.id).toBe('a');
      expect(others.map((s) => s.id)).toEqual(['b']);
    });

    it('keeps a shown review that still needs action when another gets a question', () => {
      const a = session('a', { origin: 'user' });
      const b = session('b');
      const { primary } = pickHeaderSessions([a, b], new Map([['b', 1]]), (s) => s.id === 'a', {
        id: 'a',
      });
      expect(primary?.id).toBe('a');
    });

    it('keeps a shown review with its own question when another gets one', () => {
      const a = session('a');
      const b = session('b');
      const { primary } = pickHeaderSessions(
        [a, b],
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
        never,
        { id: 'b' },
      );
      expect(primary?.id).toBe('b');
    });

    it('hands the row to a review with a question once the shown one needs nothing', () => {
      const a = session('a', { origin: 'user', waitingForAgent: true });
      const b = session('b');
      const { primary } = pickHeaderSessions([a, b], new Map([['b', 2]]), never, { id: 'a' });
      expect(primary?.id).toBe('b');
    });

    it('does not hand it over while the row is held', () => {
      const a = session('a', { origin: 'user', waitingForAgent: true });
      const b = session('b', { origin: 'user' });
      const { primary } = pickHeaderSessions([a, b], new Map([['b', 2]]), never, {
        id: 'a',
        hold: true,
      });
      expect(primary?.id).toBe('a');
    });

    it('picks afresh once the shown review ends', () => {
      const b = session('b', { origin: 'user' });
      const c = session('c', { origin: 'user' });
      const { primary } = pickHeaderSessions([b, c], new Map(), (s) => s.id === 'c', {
        id: 'a',
        hold: true,
      });
      expect(primary?.id).toBe('c');
    });
  });
});
