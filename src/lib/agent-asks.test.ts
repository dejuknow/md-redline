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
  it('returns only agentInitiated comments for the active session', () => {
    const comments = [
      mk({ id: 'c1' }),
      mk({ id: 'c2', agentInitiated: true, sessionId: 'rev_a', author: 'Claude' }),
      mk({ id: 'c3', agentInitiated: true, sessionId: 'rev_b' }),
      mk({ id: 'c4', agentInitiated: true }), // no sessionId — orphaned, excluded
    ];
    const result = selectAgentAsks(comments, 'rev_a');
    expect(result.map((c) => c.id)).toEqual(['c2']);
  });

  it('returns empty when sessionId is null', () => {
    const comments = [mk({ id: 'c2', agentInitiated: true, sessionId: 'rev_a' })];
    expect(selectAgentAsks(comments, null)).toEqual([]);
  });

  it('returns empty when no comments are agent-initiated', () => {
    const comments = [mk({ id: 'c1' }), mk({ id: 'c2' })];
    expect(selectAgentAsks(comments, 'rev_a')).toEqual([]);
  });
});
