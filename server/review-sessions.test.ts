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
        totalQuestions: 1,
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
        totalQuestions: 2,
      });
      expect(store.getPendingAsks(session.id)).toHaveLength(0);
    });

    it('resolveReplies accepts partial replies and includes totalQuestions in result', async () => {
      const store = new ReviewSessionStore();
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'c1', filePath: '/tmp/a.md', anchor: 'a', text: 'q1' },
        { commentId: 'c2', filePath: '/tmp/a.md', anchor: 'b', text: 'q2' },
        { commentId: 'c3', filePath: '/tmp/a.md', anchor: 'c', text: 'q3' },
      ]);
      // Only reply to c1 — partial is now accepted
      store.resolveReplies(session.id, askId, [{ commentId: 'c1', text: 'reply1' }]);
      const result = await waiter;
      expect(result).toEqual({
        status: 'reply',
        replies: [{ questionIndex: 0, text: 'reply1' }],
        totalQuestions: 3,
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

      const ok = store.queueBatch(session.id, ['c2', 'c3'], new Map([['/tmp/a.md', 3]]));
      expect(ok).toBe(true);

      const queued = store.getQueuedBatch(session.id);
      expect(queued?.commentIds).toEqual(['c2', 'c3']);
      expect(queued?.commentCountsByPath.get('/tmp/a.md')).toBe(3);

      const s = store.getSession(session.id)!;
      expect(s.sentCommentIds).toContain('c2');
      expect(s.sentCommentIds).toContain('c3');
    });

    it('queueBatch merges into an existing queued batch by unioning IDs and taking max-per-file counts', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']);

      store.queueBatch(session.id, ['c2'], new Map([['/tmp/a.md', 2]]));
      store.queueBatch(session.id, ['c3', 'c2'], new Map([['/tmp/a.md', 3]])); // c2 duplicate, count grew

      const queued = store.getQueuedBatch(session.id);
      expect(queued?.commentIds.sort()).toEqual(['c2', 'c3']);
      expect(queued?.commentCountsByPath.get('/tmp/a.md')).toBe(3);
    });

    it('queueBatch rejects if session is not open', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.finish(session.id);

      expect(store.queueBatch(session.id, ['c1'], new Map())).toBe(false);
    });

    it('deliverQueuedBatchIfAny returns true when a batch is queued (delivery happens via waitForSession)', async () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']);

      store.queueBatch(session.id, ['c2'], new Map([['/tmp/a.md', 2]]));

      // deliverQueuedBatchIfAny is a read-only check; actual delivery is in waitForSession.
      expect(store.deliverQueuedBatchIfAny(session.id)).toBe(true);

      // waitForSession delivers the queued batch immediately, rebuilding the prompt.
      const result = await store.waitForSession(session.id);
      expect(result.status).toBe('batch');
      if (result.status === 'batch') {
        expect(result.commentIds).toEqual(['c2']);
        // The rebuilt prompt must reference the queued comment ID.
        expect(result.prompt).toMatch(/`c2`/);
      }
      expect(store.getQueuedBatch(session.id)).toBeNull();
    });

    it('delivered prompt after merge includes the union of comment IDs, not just the latest', async () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.sendBatch(session.id, 'batch1', ['c1']);

      store.queueBatch(session.id, ['c2'], new Map([['/tmp/a.md', 2]]));
      store.queueBatch(session.id, ['c3'], new Map([['/tmp/a.md', 3]]));

      const result = await store.waitForSession(session.id);
      expect(result.status).toBe('batch');
      if (result.status === 'batch') {
        expect(result.commentIds.sort()).toEqual(['c2', 'c3']);
        // Rebuilt prompt should mention BOTH queued IDs in the scope line —
        // the bug was that prebuilt-prompt concatenation duplicated system
        // instructions instead of unioning the scope.
        expect(result.prompt).toMatch(/`c2`/);
        expect(result.prompt).toMatch(/`c3`/);
        // System instructions must appear exactly once, not twice.
        const handoffPreambleCount = (result.prompt.match(/## Comment format/g) ?? []).length;
        expect(handoffPreambleCount).toBe(1);
      }
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
      store.recordAgentComments(session.id, 1);
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

    it('dedupe-reused agent session stays protected on later silent usage', () => {
      // Reproduces the dedupe edge: agent A creates a session and posts a
      // batch (agentCommentCount > 0). A second mdr_review call from the
      // same agent dedupes onto this session via findOpenSession. The agent
      // crashes or hangs on the second usage without posting. The session
      // must remain open — the previously-posted batch already represents
      // legitimate agent activity and protects against silent-session GC.
      const store = new ReviewSessionStore();
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      store.recordAgentComments(session.id, 2); // first usage posted

      // Simulate dedupe: the same session is returned to a second tool call.
      const reused = store.findOpenSession(['/tmp/a.md'], 'agent');
      expect(reused?.id).toBe(session.id);

      // Time passes, the second usage never posts.
      vi.advanceTimersByTime(5 * 60 * 1000 + 5_000);
      store.gcSilentAgentSessions();
      expect(store.getSession(session.id)?.status).toBe('open');
      store.dispose();
    });
  });

  describe('findOpenSession', () => {
    it('returns an open session with matching file paths', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md', '/tmp/b.md'], enableResolve: false });
      const found = store.findOpenSession(['/tmp/a.md', '/tmp/b.md'], 'user');
      expect(found?.id).toBe(session.id);
    });

    it('matches regardless of file path order', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md', '/tmp/b.md'], enableResolve: false });
      const found = store.findOpenSession(['/tmp/b.md', '/tmp/a.md'], 'user');
      expect(found?.id).toBe(session.id);
    });

    it('returns undefined when no open session matches', () => {
      store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      expect(store.findOpenSession(['/tmp/other.md'], 'user')).toBeUndefined();
    });

    it('does not match across origins (user → agent)', () => {
      // An agent calling mdr_review for files the user is already reviewing
      // must get a fresh session, not the user's. The two flows have
      // incompatible terminal-state semantics (setSessionDone vs finish/abort);
      // sharing one deadlocks the agent's mdr_wait.
      const userSession = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'user',
      });
      expect(store.findOpenSession(['/tmp/a.md'], 'user')?.id).toBe(userSession.id);
      expect(store.findOpenSession(['/tmp/a.md'], 'agent')).toBeUndefined();
    });

    it('does not match across origins (agent → user)', () => {
      const agentSession = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      expect(store.findOpenSession(['/tmp/a.md'], 'agent')?.id).toBe(agentSession.id);
      expect(store.findOpenSession(['/tmp/a.md'], 'user')).toBeUndefined();
    });

    it('does not match across distinct clientIds (two different agents)', () => {
      // Claude and Codex (two MCP server processes) reviewing the same file
      // must each get their own session — sharing one would merge their
      // banners, serialize their asks, and resolve both mdr_waits on one
      // Done click.
      const claude = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
        clientId: 'mcp_claude',
      });
      expect(store.findOpenSession(['/tmp/a.md'], 'agent', 'mcp_claude')?.id).toBe(claude.id);
      expect(store.findOpenSession(['/tmp/a.md'], 'agent', 'mcp_codex')).toBeUndefined();
      expect(store.findOpenSession(['/tmp/a.md'], 'agent')).toBeUndefined();
    });

    it('matches same clientId (same agent batching successive calls)', () => {
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
        clientId: 'mcp_claude',
      });
      expect(store.findOpenSession(['/tmp/a.md'], 'agent', 'mcp_claude')?.id).toBe(session.id);
    });

    it('ignores aborted sessions', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.abort(session.id, 'user_cancelled');
      expect(store.findOpenSession(['/tmp/a.md'], 'user')).toBeUndefined();
    });

    it('ignores done sessions', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
      store.waitForSession(session.id);
      store.finish(session.id);
      expect(store.findOpenSession(['/tmp/a.md'], 'user')).toBeUndefined();
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
      expect(store.findOpenSession(['/tmp/a.md'], 'user')?.id).toBe(session.id);

      // 6 minutes in — past the 5min freshness window, should not match.
      vi.advanceTimersByTime(2 * 60_000);
      expect(store.findOpenSession(['/tmp/a.md'], 'user')).toBeUndefined();
    });

    it('matches stale-then-refreshed session once heartbeat lands', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });

      vi.advanceTimersByTime(6 * 60_000);
      expect(store.findOpenSession(['/tmp/a.md'], 'user')).toBeUndefined();

      // Browser came back from bfcache and fired a heartbeat — dedupe again.
      store.heartbeat(session.id);
      expect(store.findOpenSession(['/tmp/a.md'], 'user')?.id).toBe(session.id);
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

  describe('setSessionDone / waitForSessionDone', () => {
    it('waitForSessionDone resolves when setSessionDone is called', async () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false, origin: 'agent' });
      const waiter = store.waitForSessionDone(session.id);
      let resolved = false;
      void waiter.then(() => { resolved = true; });

      await Promise.resolve();
      expect(resolved).toBe(false);

      store.setSessionDone(session.id);
      await waiter;
      expect(resolved).toBe(true);
    });

    it('waitForSessionDone returns immediately when already done', async () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false, origin: 'agent' });
      store.setSessionDone(session.id);

      const waiter = store.waitForSessionDone(session.id);
      let resolved = false;
      void waiter.then(() => { resolved = true; });

      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it('setSessionDone is idempotent', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false, origin: 'agent' });
      expect(() => {
        store.setSessionDone(session.id);
        store.setSessionDone(session.id);
      }).not.toThrow();
    });

    it('setSessionDone rejects user-origin sessions', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false, origin: 'user' });
      expect(() => store.setSessionDone(session.id)).toThrow(/only valid for agent-origin/);
    });

    it('waitForSessionDone rejects with error for unknown session', () => {
      expect(() => store.waitForSessionDone('rev_nonexistent')).toThrow('Session not found');
    });

    it('wasSessionDone is true after setSessionDone, even after the session is gc\'d', () => {
      const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false, origin: 'agent' });
      store.setSessionDone(session.id);
      expect(store.wasSessionDone(session.id)).toBe(true);
      // Simulate the terminal-retention sweep removing the session from the live Map.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).sessions.delete(session.id);
      expect(store.getSession(session.id)).toBeUndefined();
      expect(store.wasSessionDone(session.id)).toBe(true);
    });

    it('wasSessionDone is false for unknown ids', () => {
      expect(store.wasSessionDone('rev_unknown')).toBe(false);
    });

    it('setSessionDone does NOT fire onSessionAborted (markers preserved on Done)', async () => {
      // When the user clicks Done while questions are pending, the marker is
      // a deliberate record of "this got asked, no answer" and should stay
      // in the file. Cleanup should only run for genuine abort paths
      // (tab_closed / cancelled / agent_silent), not for the Done path.
      const calls: Array<{ sessionId: string; askIds: string[] }> = [];
      store.setOnSessionAborted((sessionId, asks) => {
        calls.push({ sessionId, askIds: asks.map((a) => a.askId) });
      });
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      store.recordAgentComments(session.id, 1);
      const { waiter } = store.addAsk(session.id, [
        { commentId: 'cmt_1', filePath: '/tmp/a.md', anchor: 'x', text: 'q1' },
      ]);

      store.setSessionDone(session.id);
      await waiter;

      expect(calls).toEqual([]);
    });

    it('setSessionDone aborts any pending mdr_ask so the agent waiter unblocks', async () => {
      // Reproduces the deadlock: agent posts a question via mdr_ask, user
      // clicks Done on the unified agent banner without replying. The ask
      // waiter must resolve to no_reply (reason=done_without_reply) — otherwise
      // the agent's tool call hangs and pendingAsks leaks.
      const session = store.createSession({
        filePaths: ['/tmp/a.md'],
        enableResolve: false,
        origin: 'agent',
      });
      // Simulate the route's own "first record comments, then addAsk" ordering
      // — the addAsk invariant guard requires agentCommentCount > 0 for
      // agent-origin sessions.
      store.recordAgentComments(session.id, 1);
      const { askId, waiter } = store.addAsk(session.id, [
        { commentId: 'cmt_1', filePath: '/tmp/a.md', anchor: 'x', text: 'q1' },
      ]);
      expect(store.getPendingAsks(session.id)).toHaveLength(1);

      store.setSessionDone(session.id);

      const result = await waiter;
      expect(result).toEqual({ status: 'no_reply', reason: 'done_without_reply' });
      expect(store.getPendingAsks(session.id)).toHaveLength(0);
      // The ask map entry must be gone too — otherwise this is a memory leak.
      expect(store.waitForAsk(askId)).toBeUndefined();
    });
  });
});
