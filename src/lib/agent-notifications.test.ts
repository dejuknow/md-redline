import { describe, expect, it } from 'vitest';
import {
  AgentNotificationQueue,
  INITIAL_ROUND_STATE,
  SeenKeys,
  buildNotifications,
  detectRoundEvents,
  detectThreadEvents,
  isAgentReply,
  type AgentEvent,
  type RoundSession,
} from './agent-notifications';
import type { CommentReply, MdComment } from '../types';

const comment = (overrides: Partial<MdComment> = {}): MdComment => ({
  id: 'c1',
  anchor: 'a',
  text: 'Tighten this',
  author: 'Dana',
  timestamp: '2026-11-25T00:00:00.000Z',
  ...overrides,
});

const reply = (overrides: Partial<CommentReply> = {}): CommentReply => ({
  id: 'r1',
  text: 'Done, rewrote it',
  author: 'Claude',
  timestamp: '2026-11-25T00:01:00.000Z',
  ...overrides,
});

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('isAgentReply', () => {
  it('trusts the agent stamp either way', () => {
    expect(isAgentReply(reply({ agent: true, author: 'Dana' }), 'Dana')).toBe(true);
    expect(isAgentReply(reply({ agent: false, author: 'Claude' }), 'Dana')).toBe(false);
  });

  it('treats an unstamped reply as the agent unless it carries the reader name', () => {
    expect(isAgentReply(reply({ author: 'Claude' }), 'Dana')).toBe(true);
    expect(isAgentReply(reply({ author: ' Dana ' }), 'Dana')).toBe(false);
  });
});

describe('detectThreadEvents', () => {
  it('finds agent replies new in the file, not the reader own or old ones', () => {
    const before = [comment({ replies: [reply({ id: 'old', agent: true })] })];
    const after = [
      comment({
        replies: [
          reply({ id: 'old', agent: true }),
          reply({ id: 'mine', agent: false, author: 'Dana' }),
          reply({ id: 'new', agent: true, text: 'Fixed' }),
        ],
      }),
    ];
    const events = detectThreadEvents('/docs/spec.md', before, after, 'Dana');
    expect(events).toEqual([
      {
        kind: 'reply',
        key: 'r:new',
        filePath: '/docs/spec.md',
        commentId: 'c1',
        author: 'Claude',
        text: 'Fixed',
      },
    ]);
  });

  it('finds agent questions, but not fire-and-forget agent comments', () => {
    const after = [
      comment({
        id: 'q1',
        agentInitiated: true,
        expectsReply: true,
        author: 'Claude',
        text: 'Which?',
      }),
      comment({ id: 'note', agentInitiated: true, author: 'Claude' }),
    ];
    const events = detectThreadEvents('/docs/spec.md', [], after, 'Dana');
    expect(events.map((e) => e.key)).toEqual(['q:q1']);
    expect(events[0]).toMatchObject({ kind: 'question', commentId: 'q1', text: 'Which?' });
  });

  it('does not count a question that was already there', () => {
    const q = comment({ id: 'q1', agentInitiated: true, expectsReply: true });
    expect(detectThreadEvents('/a.md', [q], [q], 'Dana')).toEqual([]);
  });
});

describe('detectRoundEvents', () => {
  const session = (agentRounds: number | undefined, overrides: Partial<RoundSession> = {}) => ({
    id: 'rev_1',
    origin: 'user' as const,
    filePaths: ['/docs/spec.md'],
    author: 'Claude',
    agentRounds,
    ...overrides,
  });

  it('takes the first list as a baseline, then reports increases once', () => {
    const first = detectRoundEvents(INITIAL_ROUND_STATE, [session(2)]);
    expect(first.events).toEqual([]);
    const same = detectRoundEvents(first.state, [session(2)]);
    expect(same.events).toEqual([]);
    const next = detectRoundEvents(same.state, [session(3)]);
    expect(next.events).toEqual([
      {
        kind: 'round',
        key: 'f:rev_1:3',
        sessionId: 'rev_1',
        origin: 'user',
        filePaths: ['/docs/spec.md'],
        author: 'Claude',
      },
    ]);
  });

  it('counts a session that appears after the baseline from zero', () => {
    const base = detectRoundEvents(INITIAL_ROUND_STATE, []);
    const result = detectRoundEvents(base.state, [session(1, { id: 'rev_new', origin: 'agent' })]);
    expect(result.events.map((e) => e.key)).toEqual(['f:rev_new:1']);
  });

  it('ignores a server without the counter', () => {
    const base = detectRoundEvents(INITIAL_ROUND_STATE, []);
    expect(detectRoundEvents(base.state, [session(undefined)]).events).toEqual([]);
  });
});

describe('buildNotifications', () => {
  const r = (id: string, file: string, commentId = 'c1', text = `reply ${id}`): AgentEvent => ({
    kind: 'reply',
    key: `r:${id}`,
    filePath: file,
    commentId,
    author: 'Claude',
    text,
  });

  it('one reply names the file and quotes the reply', () => {
    const [n] = buildNotifications([r('1', '/docs/spec.md', 'c7', 'Rewrote the intro')]);
    expect(n).toEqual({
      id: 'r:1',
      title: 'Claude replied on spec.md',
      body: 'Rewrote the intro',
      group: '/docs/spec.md',
      target: { file: '/docs/spec.md', commentId: 'c7' },
    });
  });

  it('several replies in one file make one notification at the first thread', () => {
    const out = buildNotifications([
      r('1', '/docs/spec.md', 'c1'),
      r('2', '/docs/spec.md', 'c2'),
      r('3', '/docs/spec.md', 'c2'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Claude replied to 2 threads on spec.md');
    expect(out[0].target).toEqual({ file: '/docs/spec.md', commentId: 'c1' });
    // The quoted reply is the one in the thread the click opens.
    expect(out[0].body).toBe('reply 1');
  });

  it('a finished round takes in the replies on its files', () => {
    const out = buildNotifications([
      r('1', '/docs/spec.md'),
      r('2', '/docs/other.md'),
      {
        kind: 'round',
        key: 'f:rev_1:1',
        sessionId: 'rev_1',
        origin: 'user',
        filePaths: ['/docs/spec.md'],
        author: 'Claude',
      },
    ]);
    expect(out.map((n) => n.title)).toEqual([
      'Claude finished working on your comments',
      'Claude replied on other.md',
    ]);
    expect(out[0].body).toBe('spec.md · 1 new reply');
    expect(out[0].target).toEqual({ review: 'rev_1' });
  });

  it("leaves another agent's replies on the same file their own notification", () => {
    const out = buildNotifications([
      { ...r('1', '/docs/spec.md'), author: 'Codex' } as AgentEvent,
      {
        kind: 'round',
        key: 'f:rev_1:1',
        sessionId: 'rev_1',
        origin: 'user',
        filePaths: ['/docs/spec.md'],
        author: 'Claude',
      },
    ]);
    expect(out.map((n) => n.title)).toEqual([
      'Claude finished working on your comments',
      'Codex replied on spec.md',
    ]);
    expect(out[0].body).toBe('spec.md');
  });

  it('an agent review that finished says so', () => {
    const [n] = buildNotifications([
      {
        kind: 'round',
        key: 'f:rev_2:1',
        sessionId: 'rev_2',
        origin: 'agent',
        filePaths: ['/docs/a.md', '/docs/b.md'],
        author: 'Codex',
      },
    ]);
    expect(n.title).toBe('Codex finished reviewing');
    expect(n.body).toBe('a.md and 1 more');
  });

  it('questions come first', () => {
    const out = buildNotifications([
      r('1', '/docs/spec.md'),
      {
        kind: 'question',
        key: 'q:q1',
        filePath: '/docs/spec.md',
        commentId: 'q1',
        author: 'Claude',
        text: 'Keep both sections?',
      },
    ]);
    expect(out.map((n) => n.title)).toEqual([
      'Claude has a question on spec.md',
      'Claude replied on spec.md',
    ]);
    expect(out[0].target).toEqual({ file: '/docs/spec.md', commentId: 'q1' });
  });

  it('collapses more than three into one summary at the most urgent', () => {
    const out = buildNotifications([
      r('1', '/a.md'),
      r('2', '/b.md'),
      r('3', '/c.md'),
      {
        kind: 'question',
        key: 'q:q1',
        filePath: '/d.md',
        commentId: 'q1',
        author: 'Claude',
        text: '?',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('1 question, 3 replies. Click to open the first.');
    expect(out[0].target).toEqual({ file: '/d.md', commentId: 'q1' });
  });

  it('clips long text to one short line', () => {
    const [n] = buildNotifications([r('1', '/a.md', 'c1', `${'word '.repeat(80)}\n\nend`)]);
    expect(n.body.length).toBeLessThanOrEqual(160);
    expect(n.body.endsWith('…')).toBe(true);
    expect(n.body).not.toContain('\n');
  });
});

describe('SeenKeys', () => {
  it('remembers keys across instances and drops the oldest past the cap', () => {
    const storage = new MemoryStorage();
    const a = new SeenKeys(storage, 'k', 3);
    a.addAll(['1', '2', '3', '4']);
    const b = new SeenKeys(storage, 'k', 3);
    expect(b.has('1')).toBe(false);
    expect(['2', '3', '4'].every((k) => b.has(k))).toBe(true);
  });

  it('survives storage that throws or holds junk', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const seen = new SeenKeys(throwing);
    seen.addAll(['x']);
    expect(seen.has('x')).toBe(true);
    const junk = new MemoryStorage();
    junk.setItem('md-redline-agent-notified', '{"not":"a list"}');
    expect(new SeenKeys(junk).has('not')).toBe(false);
  });
});

describe('AgentNotificationQueue', () => {
  const ev = (id: string): AgentEvent => ({
    kind: 'reply',
    key: `r:${id}`,
    filePath: '/a.md',
    commentId: 'c1',
    author: 'Claude',
    text: id,
  });
  const timing = { quietMs: 3_000, maxHoldMs: 12_000 };

  it('releases a batch once arrivals go quiet', () => {
    const q = new AgentNotificationQueue(new SeenKeys(null), timing);
    q.add([ev('1')], 0, false);
    q.add([ev('2')], 2_000, false);
    expect(q.take(4_000, false)).toEqual([]);
    expect(q.take(5_000, false).map((e) => e.key)).toEqual(['r:1', 'r:2']);
    expect(q.take(9_000, false)).toEqual([]);
  });

  it('releases a long stream at the hold limit', () => {
    const q = new AgentNotificationQueue(new SeenKeys(null), timing);
    for (let t = 0; t <= 12_000; t += 2_000) q.add([ev(String(t))], t, false);
    expect(q.take(12_000, false)).toHaveLength(7);
  });

  it('notifies each event once, across a reload', () => {
    const storage = new MemoryStorage();
    const q = new AgentNotificationQueue(new SeenKeys(storage), timing);
    q.add([ev('1'), ev('1')], 0, false);
    q.add([ev('1')], 1_000, false);
    expect(q.take(10_000, false)).toHaveLength(1);
    const reloaded = new AgentNotificationQueue(new SeenKeys(storage), timing);
    reloaded.add([ev('1')], 20_000, false);
    expect(reloaded.size).toBe(0);
  });

  it('never queues what the reader saw, and drops what is pending when they come back', () => {
    const q = new AgentNotificationQueue(new SeenKeys(null), timing);
    q.add([ev('seen')], 0, true);
    expect(q.size).toBe(0);
    // Seen on screen, so it does not notify after the reader leaves.
    q.add([ev('seen')], 1_000, false);
    expect(q.size).toBe(0);
    q.add([ev('later')], 2_000, false);
    expect(q.take(9_000, true)).toEqual([]);
    expect(q.take(20_000, false)).toEqual([]);
  });
});
