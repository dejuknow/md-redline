import { describe, expect, it } from 'vitest';
import { selectAgentAsks } from './agent-asks';
import type { MdComment } from '../types';

const mk = (overrides: Partial<MdComment> = {}): MdComment => ({
  id: 'c1',
  anchor: 'a',
  text: 't',
  author: 'User',
  timestamp: '2026-04-26T00:00:00.000Z',
  ...overrides,
});

describe('selectAgentAsks', () => {
  it('returns only mdr_ask comments (expectsReply=true) for the active session', () => {
    const comments = [
      mk({ id: 'c1' }),
      mk({ id: 'c2', agentInitiated: true, expectsReply: true, sessionId: 'rev_a', author: 'Claude' }),
      mk({ id: 'c3', agentInitiated: true, expectsReply: true, sessionId: 'rev_b' }),
      mk({ id: 'c4', agentInitiated: true, expectsReply: true }), // no sessionId — orphaned, excluded
    ];
    const result = selectAgentAsks(comments, 'rev_a');
    expect(result.map((c) => c.id)).toEqual(['c2']);
  });

  it('excludes asks the user has marked resolved (closed without reply)', () => {
    const comments = [
      mk({ id: 'open_ask', agentInitiated: true, expectsReply: true, sessionId: 'rev_a' }),
      mk({
        id: 'resolved_ask',
        agentInitiated: true,
        expectsReply: true,
        sessionId: 'rev_a',
        status: 'resolved',
      }),
    ];
    const result = selectAgentAsks(comments, 'rev_a');
    expect(result.map((c) => c.id)).toEqual(['open_ask']);
  });

  it('excludes asks that already have a user reply (no longer pending)', () => {
    // Once the user types a reply via the sidebar, the marker carries a
    // replies array; the question is no longer pending and must drop out
    // of "Jump to next agent question" / toast so the user isn't bugged
    // about an already-answered question.
    const comments = [
      mk({
        id: 'still_pending',
        agentInitiated: true,
        expectsReply: true,
        sessionId: 'rev_a',
      }),
      mk({
        id: 'already_replied',
        agentInitiated: true,
        expectsReply: true,
        sessionId: 'rev_a',
        replies: [{ id: 'r1', text: 'my answer', author: 'User', timestamp: '2026-01-01T00:00:00.000Z' }],
      }),
    ];
    const result = selectAgentAsks(comments, 'rev_a');
    expect(result.map((c) => c.id)).toEqual(['still_pending']);
  });

  it('excludes fire-and-forget mdr_review comments (agentInitiated but expectsReply false/absent)', () => {
    // Regression guard: before the expectsReply discriminator was added,
    // both mdr_ask and mdr_review markers carried agentInitiated:true and
    // both fired the "agent has a question" toast. Only mdr_ask should now.
    const comments = [
      mk({ id: 'review_1', agentInitiated: true, sessionId: 'rev_a', author: 'Claude' }),
      mk({ id: 'ask_1', agentInitiated: true, expectsReply: true, sessionId: 'rev_a', author: 'Claude' }),
      mk({ id: 'review_2', agentInitiated: true, expectsReply: false, sessionId: 'rev_a' }),
    ];
    const result = selectAgentAsks(comments, 'rev_a');
    expect(result.map((c) => c.id)).toEqual(['ask_1']);
  });

  it('returns empty when sessionId is null', () => {
    const comments = [mk({ id: 'c2', agentInitiated: true, expectsReply: true, sessionId: 'rev_a' })];
    expect(selectAgentAsks(comments, null)).toEqual([]);
  });

  it('returns empty when no comments are agent-initiated', () => {
    const comments = [mk({ id: 'c1' }), mk({ id: 'c2' })];
    expect(selectAgentAsks(comments, 'rev_a')).toEqual([]);
  });
});
