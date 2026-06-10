import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequestReviewToolCall } from './mcp-stdio';
import type { AskWaitResult, MdrClient } from './mcp-stdio/types';
import {
  handleAskToolCall,
  handleReviewToolCall,
  handleWaitToolCall,
  __resetOpenedBrowserUrlsForTests,
} from './mcp-stdio/handler';
import { createMdrClient } from './mcp-stdio/client';

// The handler module keeps a process-scoped set of URLs it has already
// opened the browser for. Reset between tests so reused session IDs
// (rev_1 etc.) don't cross-contaminate.
beforeEach(() => __resetOpenedBrowserUrlsForTests());

describe('handleRequestReviewToolCall', () => {
  function makeReviewClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('returns batch prompt with sessionId and continue instruction', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({
        status: 'batch',
        prompt: 'BATCH PROMPT',
        commentIds: ['c1', 'c2'],
      }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('BATCH PROMPT');
    expect(result.content[0].text).toContain('rev_1');
    expect(result.content[0].text).toContain('mdr_request_review');
  });

  it('returns done prompt without continue instruction when user finishes', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({
        status: 'done',
        prompt: 'FINAL PROMPT',
      }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('FINAL PROMPT');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('returns proceed message when user finishes with no comments', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'done' }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('no more feedback');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('continue mode skips session creation and waits for next batch', async () => {
    const client = makeReviewClient({
      waitForSession: vi.fn().mockResolvedValue({
        status: 'batch',
        prompt: 'SECOND BATCH',
        commentIds: ['c3'],
      }),
    });
    const openInBrowser = vi.fn();

    const result = await handleRequestReviewToolCall(
      { mode: 'continue', sessionId: 'rev_existing' },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    // Should NOT create a session or open browser
    expect(client.grantAccess).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();

    // Should wait for session and return the batch result
    expect(client.waitForSession).toHaveBeenCalledWith('rev_existing', 90);
    expect(result.content[0].text).toContain('SECOND BATCH');
    expect(result.content[0].text).toContain('rev_existing');
  });

  it('continue mode returns done when user finishes', async () => {
    const client = makeReviewClient({
      waitForSession: vi.fn().mockResolvedValue({ status: 'done', prompt: 'FINAL' }),
    });
    const openInBrowser = vi.fn();

    const result = await handleRequestReviewToolCall(
      { mode: 'continue', sessionId: 'rev_existing' },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('FINAL');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('returns still-waiting message with sessionId when wait times out (pending)', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'pending' }),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
    };
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('rev_1');
    expect(result.content[0].text).toContain('mdr_request_review');
    expect(result.content[0].text).not.toContain('FINAL PROMPT');
    expect(result.content[0].text).not.toContain('Review handed off');
    // The pending message must forbid the agent from reading/editing the
    // in-review files, otherwise it will pick up unsubmitted @comment
    // markers the user is still typing.
    expect(result.content[0].text).toMatch(/do not have permission to read/);
    expect(result.content[0].text).toMatch(/not yours to act on/);
    expect(result.content[0].text).toMatch(/"batch" or "done"/);
  });

  it('continue mode returns still-waiting when poll times out (pending)', async () => {
    const client = {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn().mockResolvedValue({ status: 'pending' }),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
    };
    const openInBrowser = vi.fn();

    const result = await handleRequestReviewToolCall(
      { mode: 'continue', sessionId: 'rev_existing' },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('rev_existing');
    expect(result.content[0].text).toContain('mdr_request_review');
    expect(result.content[0].text).toMatch(/do not have permission to read/);
  });

  it('continue mode returns abort message when session is aborted', async () => {
    const client = makeReviewClient({
      waitForSession: vi.fn().mockResolvedValue({ status: 'aborted', reason: 'user_cancelled' }),
    });
    const openInBrowser = vi.fn();

    const result = await handleRequestReviewToolCall(
      { mode: 'continue', sessionId: 'rev_existing' },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(client.grantAccess).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('not completed');
    expect(result.content[0].text).toContain('cancelled');
  });

  it('calls sendProgress once up front when a callback is provided', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'done', prompt: 'X' }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const sendProgress = vi.fn();

    await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188', sendProgress },
    );

    expect(sendProgress).toHaveBeenCalled();
    // First call is the "waiting" message with the URL.
    expect(sendProgress.mock.calls[0][0]).toContain('waiting');
    expect(sendProgress.mock.calls[0][0]).toContain('http://localhost:5188/?review=rev_1');
  });

  it('continues calling sendProgress on an interval while the wait is in flight', async () => {
    // Run with fake timers so we can advance time deterministically.
    vi.useFakeTimers();
    try {
      let resolveWait: ((r: { status: 'done'; prompt: string }) => void) | undefined;
      const waitPromise = new Promise<{ status: 'done'; prompt: string }>((r) => {
        resolveWait = r;
      });

      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockReturnValue(waitPromise),
        abortSession: vi.fn(),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);
      const sendProgress = vi.fn();

      const promise = handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188', sendProgress },
      );

      // Flush the immediate progress ping (the "waiting for your review" line).
      await vi.advanceTimersByTimeAsync(0);
      expect(sendProgress).toHaveBeenCalledTimes(1);

      // Advance 25s: the 10s interval should fire twice (at 10s and 20s).
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sendProgress.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(sendProgress.mock.calls[1][0]).toContain('10s elapsed');
      expect(sendProgress.mock.calls[2][0]).toContain('20s elapsed');

      // Resolve the wait so the handler finishes and the interval is cleared.
      resolveWait?.({ status: 'done', prompt: 'DONE' });
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      // After resolution, advancing time must NOT fire any more progress calls.
      const callsAfterResolve = sendProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendProgress.mock.calls.length).toBe(callsAfterResolve);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a descriptive not-completed result when the session is aborted by the user', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'aborted', reason: 'user_cancelled' }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('not completed');
    expect(result.content[0].text).toContain('cancelled');
    expect(result.content[0].text).toContain('Continue with your original plan');
    expect(result.isError).toBeUndefined();
  });

  it('returns a descriptive not-completed result when the browser disconnected', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'aborted', reason: 'browser_disconnected' }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('browser tab was closed');
  });

  it('throws on createSession failure with the underlying error message', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockRejectedValue(new Error('Access denied: outside roots')),
    });
    const openInBrowser = vi.fn();

    await expect(
      handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      ),
    ).rejects.toThrow(/Access denied/);
  });

  it('throws on grantAccess failure with the underlying error message', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockRejectedValue(new Error('Cannot grant access outside allowed directories')),
    });
    const openInBrowser = vi.fn();

    await expect(
      handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/etc/passwd'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      ),
    ).rejects.toThrow(/Cannot grant access outside allowed directories/);

    // createSession must not be reached if access is denied.
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('calls abortSession when the cancellation signal fires mid-wait', async () => {
    const controller = new AbortController();
    let resolveWait: ((r: { status: 'aborted'; reason: 'user_cancelled' }) => void) | undefined;
    const waitPromise = new Promise<{ status: 'aborted'; reason: 'user_cancelled' }>((r) => {
      resolveWait = r;
    });

    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockReturnValue(waitPromise),
      abortSession: vi.fn().mockImplementation(async (sessionId: string) => {
        expect(sessionId).toBe('rev_1');
        // Simulate the server resolving the long-poll once abort fires.
        resolveWait?.({ status: 'aborted', reason: 'user_cancelled' });
      }),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    // Fire the signal shortly after the handler starts waiting.
    setTimeout(() => controller.abort(), 5);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      {
        client,
        openInBrowser,
        baseUrl: 'http://localhost:5188',
        signal: controller.signal,
      },
    );

    expect(client.abortSession).toHaveBeenCalledWith('rev_1');
    expect(result.content[0].text).toContain('Review was not completed');
    expect(result.content[0].text).toContain('cancelled');
  });

  it('skips openInBrowser when createSession returns created: false (dedup)', async () => {
    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: false }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'done', prompt: 'X' }),
      abortSession: vi.fn(),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('calls abortSession immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let resolveWait: ((r: { status: 'aborted'; reason: 'user_cancelled' }) => void) | undefined;
    const waitPromise = new Promise<{ status: 'aborted'; reason: 'user_cancelled' }>((r) => {
      resolveWait = r;
    });

    const client = makeReviewClient({
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockReturnValue(waitPromise),
      abortSession: vi.fn().mockImplementation(async () => {
        resolveWait?.({ status: 'aborted', reason: 'user_cancelled' });
      }),
    });
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      {
        client,
        openInBrowser,
        baseUrl: 'http://localhost:5188',
        signal: controller.signal,
      },
    );

    expect(client.abortSession).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Review was not completed');
  });
});

describe('handleAskToolCall', () => {
  function makeMockClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn().mockResolvedValue({ askId: 'ask_test' }),
      waitForAsk: vi.fn().mockResolvedValue({
        status: 'reply',
        replies: [{ questionIndex: 0, text: 'the answer' }],
      }),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('posts agent comments and returns the reply payload to the agent', async () => {
    const client = makeMockClient();
    const result = await handleAskToolCall(
      {
        sessionId: 'rev_xyz',
        questions: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'q?' }],
      },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(client.postAgentComments).toHaveBeenCalledWith('rev_xyz', [
      { filePath: '/tmp/a.md', anchor: 'a', text: 'q?' },
    ]);
    expect(client.waitForAsk).toHaveBeenCalledWith('rev_xyz', 'ask_test');
    expect(result.content[0].text).toContain('the answer');
    expect(result.content[0].text).toContain('questionIndex');
  });

  it('returns a no_reply result when wait reports cancelled', async () => {
    const client = makeMockClient({
      waitForAsk: vi.fn().mockResolvedValue({ status: 'no_reply', reason: 'cancelled' }),
    });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(result.content[0].text).toContain('cancelled');
  });

  it('hints re-reading the file on done_without_reply (user may have replied or edited inline)', async () => {
    const client = makeMockClient({
      waitForAsk: vi.fn().mockResolvedValue({ status: 'no_reply', reason: 'done_without_reply' }),
    });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: undefined },
    );
    const text = result.content[0].text;
    expect(text).toContain('clicked Done without replying');
    expect(text).toContain('Re-read the file');
    // Regression: the old template composed "...without replying without a
    // reply via the structured channel" — garbled copy that also told the
    // agent to skip re-reading exactly where inline replies could exist.
    expect(text).not.toContain('without replying without a reply');
  });

  it('surfaces postAgentComments failedComments in the error message', async () => {
    const err = new Error('one or more anchors could not be located') as Error & {
      failedComments?: number[];
    };
    err.failedComments = [0, 2];
    const client = makeMockClient({
      postAgentComments: vi.fn().mockRejectedValue(err),
    });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('failedComments');
  });

  it('releases the ask (not the whole session) when the cancellation signal fires', async () => {
    // Loop 3 H2: MCP tool-cancel for mdr_ask must release just the ask, not
    // tear down the entire shared session. Releasing resolves the waiter
    // with no_reply/released; the session lives on for any pending
    // mdr_wait or continued review.
    let resolveWait!: (v: AskWaitResult) => void;
    const waitPromise = new Promise<AskWaitResult>((r) => (resolveWait = r));
    let capturedAskId = '';
    const client = makeMockClient({
      postAgentComments: vi.fn().mockResolvedValue({ askId: 'ask_signal_test' }),
      waitForAsk: vi.fn().mockReturnValue(waitPromise),
      releaseAsk: vi.fn().mockImplementation(async (_sid: string, askId: string) => {
        capturedAskId = askId;
        resolveWait({ status: 'no_reply', reason: 'released' });
      }),
    });
    const ac = new AbortController();
    const promise = handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 5);
    const result = await promise;
    expect(client.releaseAsk).toHaveBeenCalledWith('rev_xyz', 'ask_signal_test');
    expect(capturedAskId).toBe('ask_signal_test');
    expect(client.abortSession).not.toHaveBeenCalled();
    // Loop 2 (4th run) reworded the 'released' message — no user-facing
    // "Release agent" button exists; the only producer is the agent's own
    // tool-cancel via cancelListener. Message now reflects that.
    expect(result.content[0].text).toContain('cancelled');
  });

  it('eager-releases the ask when signal is already aborted at await postAgentComments', async () => {
    // Regression guard for Loop 2's eager-cancel race fix: if the signal
    // fires BEFORE the cancelListener is registered (i.e. between
    // postAgentComments resolving and the addEventListener call), the
    // listener never fires and the server-side ask would otherwise hang
    // until the heartbeat sweep. The eager `if (ctx.signal?.aborted)` check
    // after the post-await must fire releaseAsk before installing the
    // listener.
    //
    // Deterministic exercise of the eager branch: signal is ALREADY aborted
    // when handleAskToolCall starts, so the check trips on first reach.
    let capturedAskId = '';
    const client = makeMockClient({
      postAgentComments: vi.fn().mockResolvedValue({ askId: 'ask_eager_test' }),
      releaseAsk: vi.fn().mockImplementation(async (_sid: string, askId: string) => {
        capturedAskId = askId;
      }),
    });
    const ac = new AbortController();
    ac.abort(); // already aborted BEFORE handleAskToolCall runs
    const result = await handleAskToolCall(
      { sessionId: 'rev_eager', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: ac.signal },
    );
    expect(client.postAgentComments).toHaveBeenCalled();
    expect(client.releaseAsk).toHaveBeenCalledWith('rev_eager', 'ask_eager_test');
    expect(capturedAskId).toBe('ask_eager_test');
    // The eager-cancel path returns immediately without entering waitForAsk.
    expect(client.waitForAsk).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('cancelled');
  });
});

describe('handleWaitToolCall', () => {
  function makeWaitClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('returns done message when user clicks Done', async () => {
    const client = makeWaitClient({
      waitForReview: vi.fn().mockResolvedValue({ status: 'done' }),
    });
    const result = await handleWaitToolCall(
      { sessionId: 'rev_1' },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(result.content[0].text).toContain('finished engaging');
    expect(result.content[0].text).toContain('Read the file');
    expect(client.waitForReview).toHaveBeenCalledWith('rev_1', 90);
  });

  it('returns pending message when timeout elapses', async () => {
    const client = makeWaitClient({
      waitForReview: vi.fn().mockResolvedValue({ status: 'pending' }),
    });
    const result = await handleWaitToolCall(
      { sessionId: 'rev_1' },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(result.content[0].text).toContain('still reviewing');
    expect(result.content[0].text).toContain('rev_1');
    expect(result.content[0].text).toContain('mdr_wait');
  });

  it('sends progress while waiting', async () => {
    const client = makeWaitClient({
      waitForReview: vi.fn().mockResolvedValue({ status: 'done' }),
    });
    const sendProgress = vi.fn();
    await handleWaitToolCall(
      { sessionId: 'rev_1' },
      { client, sendProgress, signal: undefined },
    );
    expect(sendProgress).toHaveBeenCalledWith(expect.stringContaining('rev_1'));
  });
});

describe('handleReviewToolCall (fire-and-forget)', () => {
  function makeReviewClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 2, repliesWritten: 0, commentIds: ['c1', 'c2'] }),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('posts comments and returns immediately with sessionId and count', async () => {
    const client = makeReviewClient();
    const result = await handleReviewToolCall(
      {
        filePaths: ['/abs/a.md'],
        comments: [
          { filePath: '/abs/a.md', anchor: 'foo', text: 'bar', author: 'Claude' },
        ],
      },
      { client, openInBrowser: vi.fn().mockResolvedValue(undefined), baseUrl: 'http://localhost:5188' },
    );
    expect(result.content[0].text).toContain('2 comment');
    expect(result.content[0].text).toContain('rev_1');
    expect(result.content[0].text).toContain('mdr_wait');
    // Must NOT have called waitForAsk or waitForReview
    expect(client.waitForAsk).not.toHaveBeenCalled();
    expect(client.waitForReview).not.toHaveBeenCalled();
  });

  it('opens browser on first call, skips on dedupe', async () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = makeReviewClient({
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: false }),
    });
    await handleReviewToolCall(
      { filePaths: ['/abs/a.md'], comments: [{ filePath: '/abs/a.md', anchor: 'x', text: 'y', author: 'Claude' }] },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('opens the browser AT MOST ONCE per URL even if created=true is returned repeatedly', async () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = makeReviewClient({
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
    });
    const input = {
      filePaths: ['/abs/a.md'],
      comments: [{ filePath: '/abs/a.md', anchor: 'a', text: 'x' }],
    };
    await handleReviewToolCall(input, { client, openInBrowser, baseUrl: 'http://localhost:3000' });
    await handleReviewToolCall(input, { client, openInBrowser, baseUrl: 'http://localhost:3000' });
    await handleReviewToolCall(input, { client, openInBrowser, baseUrl: 'http://localhost:3000' });
    expect(openInBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('createMdrClient HTTP methods', () => {
  it('postReview sends comments + replies (fire-and-forget, no expectsReply)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commentIds: ['cmt_1'], commentsWritten: 1, repliesWritten: 0 }), { status: 201 }),
    );
    global.fetch = fetchSpy as never;

    const client = createMdrClient('http://localhost:3000');
    const result = await client.postReview('rev_xyz', {
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
      replies: [],
    });
    expect(result.commentsWritten).toBe(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/review-sessions/rev_xyz/agent-comments',
      expect.objectContaining({
        method: 'POST',
        body: expect.not.stringContaining('expectsReply'),
      }),
    );
  });

  it('releaseAsk POSTs to the release endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    global.fetch = fetchSpy as never;
    const client = createMdrClient('http://localhost:3000');
    await client.releaseAsk('rev_xyz', 'ask_abc');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/review-sessions/rev_xyz/asks/ask_abc/release',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
