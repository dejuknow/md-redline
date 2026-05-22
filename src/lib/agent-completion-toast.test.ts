import { describe, expect, it } from 'vitest';
import { detectAgentCompletions } from './agent-completion-toast';
import type { MdComment } from '../types';
import type { ReviewSession } from '../hooks/useReviewSession';
import type { PendingAskSummary } from '../components/ReviewBanner';

const mkComment = (overrides: Partial<MdComment> = {}): MdComment => ({
  id: 'c1',
  anchor: 'some text',
  text: 'comment body',
  author: 'Claude',
  timestamp: '2026-05-20T00:00:00.000Z',
  ...overrides,
});

const mkSession = (overrides: Partial<ReviewSession> = {}): ReviewSession => ({
  id: 'rev_1',
  filePaths: ['/docs/spec.md'],
  enableResolve: false,
  status: 'open',
  sentCommentIds: [],
  waitingForAgent: false,
  origin: 'agent',
  ...overrides,
});

describe('detectAgentCompletions', () => {
  it('fires toast when agent-origin session has agent comments and no pending asks', () => {
    const session = mkSession({ id: 'rev_a', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [mkComment({ id: 'c1', agentInitiated: true, sessionId: 'rev_a', author: 'Claude' })],
      ],
    ]);

    const result = detectAgentCompletions(
      [session],
      commentsByFile,
      new Map<string, PendingAskSummary>(),
      new Set(),
    );

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('rev_a');
    expect(result[0].agentName).toBe('Claude');
    expect(result[0].commentCount).toBe(1);
  });

  it('does not fire for user-origin sessions', () => {
    const session = mkSession({ id: 'rev_b', origin: 'user', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [mkComment({ id: 'c2', agentInitiated: true, sessionId: 'rev_b', author: 'Claude' })],
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    expect(result).toHaveLength(0);
  });

  it('does not fire when agent session has no agent-initiated comments', () => {
    const session = mkSession({ id: 'rev_c', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        // user comment — not agentInitiated
        [mkComment({ id: 'c3', author: 'Dennis' })],
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    expect(result).toHaveLength(0);
  });

  it('does not fire while the session has pending asks', () => {
    const session = mkSession({ id: 'rev_d', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [mkComment({ id: 'c4', agentInitiated: true, sessionId: 'rev_d', author: 'Claude' })],
      ],
    ]);
    const pendingAsks = new Map<string, PendingAskSummary>([
      [
        'rev_d',
        {
          askId: 'ask_1',
          commentIds: ['c4'],
          agentName: 'Claude',
          readyCount: 0,
        },
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, pendingAsks, new Set());
    expect(result).toHaveLength(0);
  });

  it('does not fire a second time for an already-toasted session', () => {
    const session = mkSession({ id: 'rev_e', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [mkComment({ id: 'c5', agentInitiated: true, sessionId: 'rev_e', author: 'Claude' })],
      ],
    ]);
    const alreadyToasted = new Set(['rev_e']);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), alreadyToasted);
    expect(result).toHaveLength(0);
  });

  it('counts agent comments across multiple files in the session', () => {
    const session = mkSession({
      id: 'rev_f',
      origin: 'agent',
      filePaths: ['/docs/a.md', '/docs/b.md'],
    });
    const commentsByFile = new Map([
      [
        '/docs/a.md',
        [mkComment({ id: 'c6', agentInitiated: true, sessionId: 'rev_f', author: 'Claude' })],
      ],
      [
        '/docs/b.md',
        [
          mkComment({ id: 'c7', agentInitiated: true, sessionId: 'rev_f', author: 'Claude' }),
          mkComment({ id: 'c8', agentInitiated: true, sessionId: 'rev_f', author: 'Claude' }),
        ],
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].commentCount).toBe(3);
  });

  it('uses first agent comment author; falls back to Agent when no author', () => {
    const session = mkSession({ id: 'rev_g', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [mkComment({ id: 'c9', agentInitiated: true, sessionId: 'rev_g', author: '' })],
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('Agent');
  });

  it('does not count comments from other sessions', () => {
    const session = mkSession({ id: 'rev_h', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        // agentInitiated but belongs to a different session
        [mkComment({ id: 'c10', agentInitiated: true, sessionId: 'rev_other', author: 'Claude' })],
      ],
    ]);

    const result = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    expect(result).toHaveLength(0);
  });

  it('shows toast text matching /left N comments?/', () => {
    const session = mkSession({ id: 'rev_i', origin: 'agent', filePaths: ['/docs/spec.md'] });
    const commentsByFile = new Map([
      [
        '/docs/spec.md',
        [
          mkComment({ id: 'c11', agentInitiated: true, sessionId: 'rev_i', author: 'Claude' }),
          mkComment({ id: 'c12', agentInitiated: true, sessionId: 'rev_i', author: 'Claude' }),
        ],
      ],
    ]);

    const [info] = detectAgentCompletions([session], commentsByFile, new Map(), new Set());
    const toastText = `${info.agentName} left ${info.commentCount} comment${info.commentCount === 1 ? '' : 's'}`;
    expect(toastText).toMatch(/left \d+ comments?/);
  });
});
