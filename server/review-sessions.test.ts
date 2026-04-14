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

  it('sweep aborts sessions whose heartbeat is older than 30s', async () => {
    store.startSweep(10_000); // sweep every 10s

    const session = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const waiter = store.waitForSession(session.id);

    // 20s passes — still healthy
    vi.advanceTimersByTime(20_000);
    expect(store.getSession(session.id)?.status).toBe('open');

    // Another 20s passes (40s total since last heartbeat) — should be swept
    vi.advanceTimersByTime(20_000);

    const result = await waiter;
    expect(result).toEqual({ status: 'aborted', reason: 'browser_disconnected' });
    expect(store.getSession(session.id)?.status).toBe('aborted');
  });

  it('sweep does not touch done or already-aborted sessions', () => {
    store.startSweep(10_000);
    const a = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    store.waitForSession(a.id);
    store.finish(a.id, 'done');

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

    vi.advanceTimersByTime(29_000);
    expect(store.finish(session.id, 'WINNER', ['c1'])).toBe(true);
    vi.advanceTimersByTime(20_000);

    const result = await waiter;
    expect(result).toEqual({ status: 'done', prompt: 'WINNER' });
    expect(store.getSession(session.id)?.status).toBe('done');
  });

  it('sweep aborts only stale sessions when several coexist with staggered heartbeats', async () => {
    store.startSweep(10_000);
    const a = store.createSession({ filePaths: ['/tmp/a.md'], enableResolve: false });
    const aWaiter = store.waitForSession(a.id);

    // 20s in, create b. a is 20s stale (still within 30s threshold), b is fresh.
    vi.advanceTimersByTime(20_000);
    const b = store.createSession({ filePaths: ['/tmp/b.md'], enableResolve: false });

    // Advance to t=45 total. Sweeps at t=30 and t=40 both fire.
    // At t=40: a's heartbeat is 40s old (past threshold) → aborted.
    //          b's heartbeat is 20s old (within threshold) → still open.
    vi.advanceTimersByTime(25_000);

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
});
