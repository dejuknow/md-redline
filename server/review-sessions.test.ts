import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ReviewSessionStore } from './review-sessions';

describe('ReviewSessionStore', () => {
  let store: ReviewSessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ReviewSessionStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it('creates a session with a unique id and returns it from getSession', () => {
    const session = store.createSession({
      filePaths: ['/tmp/a.md', '/tmp/b.md'],
      enableResolve: false,
    });

    expect(session.id).toMatch(/^rev_[a-f0-9-]+$/);
    expect(session.filePaths).toEqual(['/tmp/a.md', '/tmp/b.md']);
    expect(session.enableResolve).toBe(false);
    expect(session.status).toBe('open');

    expect(store.getSession(session.id)).toEqual(session);
  });

  it('lists only open sessions from listOpenSessions', () => {
    const a = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const b = store.createSession({ filePaths: ['/tmp/b.md'], enableResolve: false });

    expect(store.listOpenSessions().map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('sendBatch resolves the waiter with batch status and keeps the session open', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    const ok = store.sendBatch(session.id, 'BATCH PROMPT', ['c1', 'c2']);
    expect(ok).toBe(true);

    const result = await waiter;
    expect(result).toEqual({ status: 'batch', prompt: 'BATCH PROMPT', commentIds: ['c1', 'c2'] });
    expect(store.getSession(session.id)?.status).toBe('open');
  });

  it('sendBatch accumulates sentCommentIds across batches', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch1', ['c1', 'c2']);

    // Agent re-attaches, clearing waitingForAgent
    store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch2', ['c3']);

    const s = store.getSession(session.id)!;
    expect(s.sentCommentIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('after sendBatch, waitForSession returns a NEW promise that blocks', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter1 = store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch1', ['c1']);
    await waiter1;

    // The agent calls waitForSession again — should get a new promise
    const waiter2 = store.waitForSession(session.id);
    let resolved = false;
    void waiter2.then(() => { resolved = true; });

    // Flush microtasks — waiter2 should NOT have resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Next batch resolves waiter2
    store.sendBatch(session.id, 'batch2', ['c2']);
    const result = await waiter2;
    expect(result).toEqual({ status: 'batch', prompt: 'batch2', commentIds: ['c2'] });
  });

  it('sendBatch while waitingForAgent returns false', () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch1', ['c1']);

    // Agent has NOT called waitForSession yet — waitingForAgent is true
    expect(store.sendBatch(session.id, 'batch2', ['c2'])).toBe(false);
  });

  it('finish with prompt resolves waiter with done status', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    const ok = store.finish(session.id, 'FINAL PROMPT', ['c1']);
    expect(ok).toBe(true);

    const result = await waiter;
    expect(result).toEqual({ status: 'done', prompt: 'FINAL PROMPT' });
    expect(store.getSession(session.id)?.status).toBe('done');
    expect(store.getSession(session.id)?.sentCommentIds).toEqual(['c1']);
  });

  it('finish without prompt resolves waiter with done status and no prompt', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    const ok = store.finish(session.id);
    expect(ok).toBe(true);

    const result = await waiter;
    expect(result).toEqual({ status: 'done' });
    expect(store.getSession(session.id)?.status).toBe('done');
  });

  it('finish on already-resolved session returns false', () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.finish(session.id);
    expect(store.finish(session.id)).toBe(false);
  });

  it('abort resolves the waiter with the supplied reason and marks status', async () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    const ok = store.abort(session.id, 'user_cancelled');
    expect(ok).toBe(true);

    const result = await waiter;
    expect(result).toEqual({ status: 'aborted', reason: 'user_cancelled' });
    expect(store.getSession(session.id)?.status).toBe('aborted');
  });

  it('sendBatch/finish on unknown session returns false', () => {
    expect(store.sendBatch('rev_nope', 'x', ['c1'])).toBe(false);
    expect(store.finish('rev_nope')).toBe(false);
    expect(store.abort('rev_nope', 'user_cancelled')).toBe(false);
  });

  it('waitForSession throws on unknown session', () => {
    expect(() => store.waitForSession('rev_nope')).toThrow(/Session not found/);
  });

  it('heartbeat updates lastHeartbeatAt', () => {
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const before = store.getSession(session.id)!.lastHeartbeatAt.getTime();

    vi.advanceTimersByTime(15_000);
    expect(store.heartbeat(session.id)).toBe(true);

    const after = store.getSession(session.id)!.lastHeartbeatAt.getTime();
    expect(after - before).toBeGreaterThanOrEqual(15_000);
  });

  it('sweep aborts sessions whose heartbeat is older than the timeout (30 min)', async () => {
    store.startSweep(10_000); // sweep every 10s

    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    // 5 min in — well within the 30-min backstop. Backgrounded tabs whose
    // heartbeats are throttled by Chrome must not be killed here.
    vi.advanceTimersByTime(5 * 60_000);
    expect(store.getSession(session.id)?.status).toBe('open');

    // 31 min total — past the 30-min crash backstop. Next sweep aborts.
    vi.advanceTimersByTime(26 * 60_000);

    const result = await waiter;
    expect(result).toEqual({ status: 'aborted', reason: 'browser_disconnected' });
    expect(store.getSession(session.id)?.status).toBe('aborted');
  });

  it('sweep does not touch done or already-aborted sessions', () => {
    store.startSweep(10_000);
    const a = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(a.id);
    store.finish(a.id, 'done');

    // Note: stay inside TERMINAL_RETENTION_MS (5 min) so the session is
    // still resolvable; the assertion is that sweep didn't mutate status.
    vi.advanceTimersByTime(60_000);
    expect(store.getSession(a.id)?.status).toBe('done');
  });

  it('heartbeat on unknown session returns false', () => {
    expect(store.heartbeat('rev_nope')).toBe(false);
  });

  it('finish wins over sweep once the session is marked done', async () => {
    store.startSweep(10_000);
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    // Just before the 30-min backstop, mark the session done. Sweeps after
    // the timeout must not flip the resolved session back to 'aborted'.
    vi.advanceTimersByTime(29 * 60_000);
    expect(store.finish(session.id, 'WINNER', ['c1'])).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);

    const result = await waiter;
    expect(result).toEqual({ status: 'done', prompt: 'WINNER' });
    expect(store.getSession(session.id)?.status).toBe('done');
  });

  it('sweep aborts only stale sessions when several coexist with staggered heartbeats', async () => {
    store.startSweep(10_000);
    const a = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const aWaiter = store.waitForSession(a.id);

    // 10 min in, create b. a is 10 min stale (still within 30-min
    // threshold), b is fresh.
    vi.advanceTimersByTime(10 * 60_000);
    const b = store.createSession({ filePaths: ['/tmp/b.md'], enableResolve: false });

    // Advance to t=31 min total. a is 31 min stale → swept. b is 21 min
    // stale → still open.
    vi.advanceTimersByTime(21 * 60_000);

    const aResult = await aWaiter;
    expect(aResult).toEqual({ status: 'aborted', reason: 'browser_disconnected' });
    expect(store.getSession(a.id)?.status).toBe('aborted');
    expect(store.getSession(b.id)?.status).toBe('open');
  });

  it('sweep auto-clears waitingForAgent after 60s if agent does not pick up', () => {
    store.startSweep(10_000);
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch1', ['c1']);

    // waitingForAgent is true, agent hasn't called waitForSession
    expect(store.getSession(session.id)?.waitingForAgent).toBe(true);

    // Keep the session alive with heartbeats (browser tab is still open)
    vi.advanceTimersByTime(25_000);
    store.heartbeat(session.id);

    // 50s total — still within 60s timeout
    vi.advanceTimersByTime(25_000);
    store.heartbeat(session.id);
    expect(store.getSession(session.id)?.waitingForAgent).toBe(true);

    // 70s total — past the 60s timeout, next sweep clears it
    vi.advanceTimersByTime(20_000);
    store.heartbeat(session.id);
    expect(store.getSession(session.id)?.waitingForAgent).toBe(false);

    // User can send another batch now
    expect(store.sendBatch(session.id, 'batch2', ['c2'])).toBe(true);
  });

  it('sweep does not clear waitingForAgent if agent picks up in time', () => {
    store.startSweep(10_000);
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.sendBatch(session.id, 'batch1', ['c1']);

    // Keep alive
    vi.advanceTimersByTime(25_000);
    store.heartbeat(session.id);

    // Agent picks up after 30s (within the 60s timeout)
    vi.advanceTimersByTime(5_000);
    store.waitForSession(session.id); // clears waitingForAgent

    expect(store.getSession(session.id)?.waitingForAgent).toBe(false);
  });

  it('terminal sessions are retained for the resolution window then aged out', async () => {
    store.startSweep(10_000);
    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(session.id);
    store.finish(session.id, 'done');

    // Still retrievable immediately after resolution (callers may still be
    // awaiting /wait or /:id after the Send click).
    expect(store.getSession(session.id)?.status).toBe('done');

    // Still retrievable four minutes later (inside the retention window).
    vi.advanceTimersByTime(4 * 60_000);
    expect(store.getSession(session.id)?.status).toBe('done');

    // Six minutes total — past the retention window. Next sweep removes it.
    vi.advanceTimersByTime(2 * 60_000);
    expect(store.getSession(session.id)).toBeUndefined();
  });

  describe('ReviewSessionStore — pendingAsks', () => {
    it('addAsk creates a pending ask with its own waiter', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
      ]);
      expect(askId).toMatch(/^ask_/);
      expect(store.getPendingAsks(session.id)).toHaveLength(1);
      expect(store.getPendingAsks(session.id)[0].askId).toBe(askId);
      store.resolveReplies(session.id, askId, [{ commentId: 'c1', text: 'reply' }]);
      const result = await waiter;
      expect(result).toEqual({
        status: 'reply',
        replies: [{ questionIndex: 0, text: 'reply' }],
      });
    });

    it('addAsk rejects a second ask while another is pending for the same session', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.addAsk(session.id, [{ commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' }]);
      expect(() =>
        store.addAsk(session.id, [{ commentId: 'c2', filePath: '/tmp/a.md', anchor: 'b', text: 'q2' }]),
      ).toThrow(/previous mdr_ask is still pending/);
    });

    it('addAsk throws when the session is not open', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.finish(session.id);
      expect(() =>
        store.addAsk(session.id, [{ commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' }]),
      ).toThrow(/session not found or already finished/);
    });

    it('resolveReplies bundles replies in question order', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
        { commentId: 'c2', filePath: '/tmp/a.md', anchor: 'b', text: 'q2' },
      ]);
      store.resolveReplies(session.id, askId, [
        { commentId: 'c2', text: 'reply2' },
        { commentId: 'c1', text: 'reply1' },
      ]);
      const result = await waiter;
      expect(result).toEqual({
        status: 'reply',
        replies: [
          { questionIndex: 0, text: 'reply1' },
          { questionIndex: 1, text: 'reply2' },
        ],
      });
      expect(store.getPendingAsks(session.id)).toHaveLength(0);
    });

    it('abortAsks resolves pending ask waiters with no_reply/cancelled', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
      ]);
      store.abortAsks(session.id, 'session_cancelled');
      const result = await waiter;
      expect(result).toEqual({ status: 'no_reply', reason: 'cancelled' });
      expect(store.getPendingAsks(session.id)).toHaveLength(0);
      void askId;
    });

    it('abort() also fires abortAsks for any pending asks on that session', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
      ]);
      store.abort(session.id, 'user_cancelled');
      const result = await waiter;
      expect(result.status).toBe('no_reply');
    });
  });

  describe('ReviewSessionStore — onSessionAborted callback', () => {
    it('fires callback with the aborted session id and pending asks when sweep aborts a session', async () => {
      const store = new ReviewSessionStore();
      const calls: Array<{ sessionId: string; askIds: string[] }> = [];
      store.setOnSessionAborted((sessionId, asks) => {
        calls.push({ sessionId, askIds: asks.map((a) => a.askId) });
      });
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
      ]);

      // Force a stale heartbeat so the sweep aborts the session.
      const internal = (store as unknown as { sessions: Map<string, { lastHeartbeatAt: Date }> }).sessions.get(session.id)!;
      internal.lastHeartbeatAt = new Date(Date.now() - 31 * 60_000);
      (store as unknown as { sweepStale: () => void }).sweepStale();

      expect(calls).toEqual([{ sessionId: session.id, askIds: [askId] }]);
      expect(await waiter).toEqual({ status: 'no_reply', reason: 'tab_closed' });
    });

    it('fires callback when abort() is called explicitly with pending asks', async () => {
      const store = new ReviewSessionStore();
      const calls: Array<{ sessionId: string; askIds: string[] }> = [];
      store.setOnSessionAborted((sessionId, asks) => {
        calls.push({ sessionId, askIds: asks.map((a) => a.askId) });
      });
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
      ]);
      store.abort(session.id, 'user_cancelled');
      expect(calls).toEqual([{ sessionId: session.id, askIds: [askId] }]);
      expect(await waiter).toEqual({ status: 'no_reply', reason: 'cancelled' });
    });
  });

  describe('queueBatch / deliverQueuedBatchIfAny', () => {
    it('queueBatch adds a batch and updates sentCommentIds', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']); // sets waitingForAgent

      const ok = store.queueBatch(session.id, 'queued prompt', ['c2', 'c3']);
      expect(ok).toBe(true);

      const queued = store.getQueuedBatch(session.id);
      expect(queued).toEqual({ prompt: 'queued prompt', commentIds: ['c2', 'c3'] });

      const s = store.getSession(session.id)!;
      expect(s.sentCommentIds).toContain('c2');
      expect(s.sentCommentIds).toContain('c3');
    });

    it('queueBatch merges into an existing queued batch', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']);

      store.queueBatch(session.id, 'first queued', ['c2']);
      store.queueBatch(session.id, 'second queued', ['c3', 'c2']); // c2 duplicate

      const queued = store.getQueuedBatch(session.id);
      expect(queued?.prompt).toBe('first queued\n\nsecond queued');
      expect(queued?.commentIds.sort()).toEqual(['c2', 'c3']);
    });

    it('queueBatch rejects if session is not open', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.finish(session.id);

      expect(store.queueBatch(session.id, 'prompt', ['c1'])).toBe(false);
    });

    it('deliverQueuedBatchIfAny returns true when a batch is queued (delivery happens via waitForSession)', async () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']);

      store.queueBatch(session.id, 'queued prompt', ['c2']);

      // deliverQueuedBatchIfAny is a read-only check; actual delivery is in waitForSession.
      expect(store.deliverQueuedBatchIfAny(session.id)).toBe(true);

      // waitForSession delivers the queued batch immediately.
      const result = await store.waitForSession(session.id);
      expect(result).toEqual({ status: 'batch', prompt: 'queued prompt', commentIds: ['c2'] });
      expect(store.getQueuedBatch(session.id)).toBeNull();
    });

    it('deliverQueuedBatchIfAny returns false when no batch is queued', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      expect(store.deliverQueuedBatchIfAny(session.id)).toBe(false);
    });
  });

  describe('releaseAsk', () => {
    it('resolves the ask waiter with released status', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/test.md'],
        enableResolve: false,
        origin: 'agent',
      });
      const { askId } = store.addAsk(session.id, [
        { commentId: 'cmt_1', filePath: '/tmp/test.md', anchor: 'hi', text: 'q1' },
      ]);
      const waiter = store.waitForAsk(askId)!;
      const ok = store.releaseAsk(session.id, askId);
      expect(ok).toBe(true);
      const result = await waiter;
      expect(result).toEqual({ status: 'no_reply', reason: 'released' });
    });

    it('returns false for unknown ask', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/test.md'],
        enableResolve: false,
      });
      expect(store.releaseAsk(session.id, 'ask_unknown')).toBe(false);
    });

    it('is idempotent on second call', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/test.md'],
        enableResolve: false,
      });
      const { askId } = store.addAsk(session.id, [
        { commentId: 'cmt_1', filePath: '/tmp/test.md', anchor: 'hi', text: 'q1' },
      ]);
      expect(store.releaseAsk(session.id, askId)).toBe(true);
      expect(store.releaseAsk(session.id, askId)).toBe(false);
    });
  });

  describe('session origin', () => {
    it('defaults origin to "user" when not specified', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
      });
      expect(session.origin).toBe('user');
    });

    it('records origin "agent" when specified', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      expect(session.origin).toBe('agent');
    });
  });

  describe('silent agent session GC', () => {
    it('aborts agent-origin sessions with no comments after timeout', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      store.gcSilentAgentSessions();
      expect(store.getSession(session.id)?.status).toBe('aborted');
      store.dispose();
    });

    it('does not abort user-origin sessions for being silent', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'user',
      });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      store.gcSilentAgentSessions();
      expect(store.getSession(session.id)?.status).toBe('open');
      store.dispose();
    });

    it('does not abort agent sessions once comments have been posted', () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      store.recordAgentComments(session.id, 1); // simulate that agent has posted
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      store.gcSilentAgentSessions();
      expect(store.getSession(session.id)?.status).toBe('open');
      store.dispose();
    });
  });

  describe('findOpenSession', () => {
    it('returns an open session with matching file paths', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md', '/tmp/b.md'], enableResolve: false });
      const found = store.findOpenSession(['/tmp/a.md', '/tmp/b.md']);
      expect(found?.id).toBe(session.id);
    });

    it('matches regardless of file path order', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md', '/tmp/b.md'], enableResolve: false });
      const found = store.findOpenSession(['/tmp/b.md', '/tmp/a.md']);
      expect(found?.id).toBe(session.id);
    });

    it('returns undefined when no open session matches', () => {
      store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      expect(store.findOpenSession(['/tmp/other.md'])).toBeUndefined();
    });

    it('ignores aborted sessions', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.abort(session.id, 'user_cancelled');
      expect(store.findOpenSession(['/tmp/a.md'])).toBeUndefined();
    });

    it('ignores done sessions', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.finish(session.id);
      expect(store.findOpenSession(['/tmp/a.md'])).toBeUndefined();
    });

    // The freshness gate offsets the long HEARTBEAT_TIMEOUT_MS backstop:
    // crash-leaked sessions sit in the open pool for up to 30 min before
    // being swept, so without this check, a fresh mdr_request_review for the
    // same files would attach to the dead one. The threshold is 5 minutes
    // — well above the client's 10s heartbeat cadence and above the
    // typical gap between batched agent tool calls.
    it('ignores open sessions whose last heartbeat is too stale to dedupe to', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });

      // 4 minutes in — still fresh, should match.
      vi.advanceTimersByTime(4 * 60_000);
      expect(store.findOpenSession(['/tmp/a.md'])?.id).toBe(session.id);

      // 6 minutes in — past the 5min freshness window, should not match.
      vi.advanceTimersByTime(2 * 60_000);
      expect(store.findOpenSession(['/tmp/a.md'])).toBeUndefined();
    });

    it('matches stale-then-refreshed session once heartbeat lands', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });

      vi.advanceTimersByTime(6 * 60_000);
      expect(store.findOpenSession(['/tmp/a.md'])).toBeUndefined();

      // Browser came back from bfcache and fired a heartbeat — dedupe again.
      store.heartbeat(session.id);
      expect(store.findOpenSession(['/tmp/a.md'])?.id).toBe(session.id);
    });
  });

  describe('recordAgentComments — lastAgentActivityAt', () => {
    it('sets lastAgentActivityAt to the current time when comments are recorded', () => {
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      // Before any comments, lastAgentActivityAt is null
      expect(store.getSession(session.id)?.lastAgentActivityAt).toBeNull();

      const before = new Date();
      store.recordAgentComments(session.id, 2);
      const after = new Date();

      const ts = store.getSession(session.id)?.lastAgentActivityAt;
      expect(ts).not.toBeNull();
      const recorded = new Date(ts!);
      expect(recorded.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(recorded.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('toPublic returns lastAgentActivityAt as an ISO string after recording', () => {
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      store.recordAgentComments(session.id, 1);
      const pub = store.getSession(session.id)!;
      expect(typeof pub.lastAgentActivityAt).toBe('string');
      // Should be parseable as an ISO date
      expect(isNaN(new Date(pub.lastAgentActivityAt!).getTime())).toBe(false);
    });

    it('toPublic returns null for lastAgentActivityAt before any comments are recorded', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const pub = store.getSession(session.id)!;
      expect(pub.lastAgentActivityAt).toBeNull();
    });
  });
});
