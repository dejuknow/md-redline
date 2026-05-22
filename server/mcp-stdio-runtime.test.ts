import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequestReviewToolCall } from './mcp-stdio';
import type { AskWaitResult, MdrClient } from './mcp-stdio/types';
import {
  handleAskToolCall,
  handleReviewToolCall,
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

  it('aborts the ask when the cancellation signal fires', async () => {
    let resolveWait!: (v: AskWaitResult) => void;
    const waitPromise = new Promise<AskWaitResult>((r) => (resolveWait = r));
    const client = makeMockClient({
      waitForAsk: vi.fn().mockReturnValue(waitPromise),
      abortSession: vi.fn().mockImplementation(async () => {
        resolveWait({ status: 'no_reply', reason: 'cancelled' });
      }),
    });
    const ac = new AbortController();
    const promise = handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 5);
    const result = await promise;
    expect(client.abortSession).toHaveBeenCalledWith('rev_xyz');
    expect(result.content[0].text).toContain('cancelled');
  });
});

describe('handleReviewToolCall', () => {
  const baseCtx = {
    baseUrl: 'http://localhost:3000',
    openInBrowser: vi.fn().mockResolvedValue(undefined),
    getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: false }),
  };

  it('fire-and-forget happy path returns immediately', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 2, repliesWritten: 0 }),
    };
    const result = await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [
          { filePath: '/tmp/a.md', anchor: 'a', text: 'x' },
          { filePath: '/tmp/a.md', anchor: 'b', text: 'y' },
        ],
      },
      { client: client as unknown as MdrClient, ...baseCtx },
    );
    expect(result.isError).toBeFalsy();
    expect(client.postReview).toHaveBeenCalledWith('rev_1', expect.objectContaining({ expectsReply: false }));
  });

  it('omitted waitForResponse defaults to user setting', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      postReview: vi.fn().mockResolvedValue({ askId: 'ask_1', commentsWritten: 1, repliesWritten: 0 }),
      waitForAsk: vi.fn().mockResolvedValue({ status: 'reply', replies: [{ questionIndex: 0, text: 'ok' }] }),
    };
    const ctx = {
      ...baseCtx,
      getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: true }),
    };
    await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
      },
      { client: client as unknown as MdrClient, ...ctx },
    );
    expect(client.postReview).toHaveBeenCalledWith('rev_1', expect.objectContaining({ expectsReply: true }));
    expect(client.waitForAsk).toHaveBeenCalledWith('rev_1', 'ask_1');
  });

  it('explicit waitForResponse=false overrides user setting', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 1, repliesWritten: 0 }),
    };
    const ctx = {
      ...baseCtx,
      getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: true }),
    };
    await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
        waitForResponse: false,
      },
      { client: client as unknown as MdrClient, ...ctx },
    );
    expect(client.postReview).toHaveBeenCalledWith('rev_1', expect.objectContaining({ expectsReply: false }));
  });

  it('surfaces no_reply with reason released', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      postReview: vi.fn().mockResolvedValue({ askId: 'ask_1', commentsWritten: 1, repliesWritten: 0 }),
      waitForAsk: vi.fn().mockResolvedValue({ status: 'no_reply', reason: 'released' }),
    };
    const result = await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
        waitForResponse: true,
      },
      { client: client as unknown as MdrClient, ...baseCtx },
    );
    expect(result.content[0].text).toMatch(/released/);
    expect(result.content[0].text).toMatch(/may reply later/);
  });

  it('opens the browser on first session creation (created=true)', async () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'rev_1',
        url: '/?review=rev_1',
        created: true,
      }),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 1, repliesWritten: 0 }),
    };
    await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
      },
      {
        client: client as unknown as MdrClient,
        baseUrl: 'http://localhost:3000',
        openInBrowser,
        getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: false }),
      },
    );
    expect(openInBrowser).toHaveBeenCalledTimes(1);
    expect(openInBrowser).toHaveBeenCalledWith('http://localhost:3000/?review=rev_1');
  });

  it('does NOT open the browser when reusing an existing session (created=false)', async () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'rev_1',
        url: '/?review=rev_1',
        created: false,
      }),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 1, repliesWritten: 0 }),
    };
    await handleReviewToolCall(
      {
        filePaths: ['/tmp/a.md'],
        comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
      },
      {
        client: client as unknown as MdrClient,
        baseUrl: 'http://localhost:3000',
        openInBrowser,
        getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: false }),
      },
    );
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('opens the browser AT MOST ONCE per URL even if created=true is returned repeatedly', async () => {
    // Defensive case: even if something upstream lies about `created`, the
    // module-scoped openedUrls set prevents duplicate tabs for the same URL.
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      // Returns created: true on every call (the buggy upstream we're defending against).
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'rev_1',
        url: '/?review=rev_1',
        created: true,
      }),
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 1, repliesWritten: 0 }),
    };
    const ctx = {
      client: client as unknown as MdrClient,
      baseUrl: 'http://localhost:3000',
      openInBrowser,
      getUserSettings: vi.fn().mockResolvedValue({ defaultAgentReviewWait: false }),
    };
    const input = {
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: 'a', text: 'x' }],
    };
    // Call the handler three times — simulating a batched agent making
    // multiple successive mdr_review tool calls.
    await handleReviewToolCall(input, ctx);
    await handleReviewToolCall(input, ctx);
    await handleReviewToolCall(input, ctx);
    expect(openInBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('createMdrClient HTTP methods', () => {
  it('postReview sends comments + replies + expectsReply', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commentIds: ['cmt_1'], commentsWritten: 1, repliesWritten: 0 }), { status: 201 }),
    );
    global.fetch = fetchSpy as never;

    const client = createMdrClient('http://localhost:3000');
    const result = await client.postReview('rev_xyz', {
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
      replies: [],
      expectsReply: false,
    });
    expect(result.commentsWritten).toBe(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/review-sessions/rev_xyz/agent-comments',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"expectsReply":false'),
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
