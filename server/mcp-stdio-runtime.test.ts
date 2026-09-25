import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequestReviewToolCall } from './mcp-stdio';
import type { AskWaitResult, MdrClient } from './mcp-stdio/types';
import {
  handleAddFilesToolCall,
  handleAskToolCall,
  handleBaselineToolCall,
  handleReviewToolCall,
  handleWaitToolCall,
  __resetOpenedBrowserUrlsForTests,
} from './mcp-stdio/handler';
import { createMdrClient, ServerUnreachableError } from './mcp-stdio/client';

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
      captureBaseline: vi.fn(),
      getSessionFilePaths: vi.fn().mockResolvedValue([]),
      listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
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
    expect(client.waitForSession).toHaveBeenCalledWith('rev_existing', 90, undefined);
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
      captureBaseline: vi.fn(),
      getSessionFilePaths: vi.fn().mockResolvedValue([]),
      listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
      addSessionFiles: vi.fn(),
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
      captureBaseline: vi.fn(),
      getSessionFilePaths: vi.fn().mockResolvedValue([]),
      listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
      addSessionFiles: vi.fn(),
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
      waitForSession: vi
        .fn()
        .mockResolvedValue({ status: 'aborted', reason: 'browser_disconnected' }),
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
      grantAccess: vi
        .fn()
        .mockRejectedValue(new Error('Cannot grant access outside allowed directories')),
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
      createSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: false }),
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

  describe('missing baseline note', () => {
    it('appends a note to a batch result when the store held no copy for a session file', async () => {
      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockResolvedValue({
          status: 'batch',
          prompt: 'BATCH PROMPT',
          commentIds: ['c1'],
        }),
        getSessionFilePaths: vi.fn().mockResolvedValue(['/abs/a.md']),
        listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);

      const result = await handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      );

      expect(result.content[0].text).toContain('no before copy');
      expect(result.content[0].text).toContain('/abs/a.md');
    });

    it('does not append the note when the store already held a copy for the session file', async () => {
      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockResolvedValue({
          status: 'batch',
          prompt: 'BATCH PROMPT',
          commentIds: ['c1'],
        }),
        getSessionFilePaths: vi.fn().mockResolvedValue(['/abs/a.md']),
        listBaselines: vi.fn().mockResolvedValue({
          baselines: [{ path: '/abs/a.md', capturedAt: 1, bytes: 10 }],
        }),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);

      const result = await handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      );

      expect(result.content[0].text).not.toContain('no before copy');
    });

    it('appends the note to a done result carrying a prompt', async () => {
      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockResolvedValue({ status: 'done', prompt: 'FINAL PROMPT' }),
        getSessionFilePaths: vi.fn().mockResolvedValue(['/abs/a.md']),
        listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);

      const result = await handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      );

      expect(result.content[0].text).toContain('FINAL PROMPT');
      expect(result.content[0].text).toContain('no before copy');
    });

    it('appends the note to a done result with no comments', async () => {
      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockResolvedValue({ status: 'done' }),
        getSessionFilePaths: vi.fn().mockResolvedValue(['/abs/a.md']),
        listBaselines: vi.fn().mockResolvedValue({ baselines: [] }),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);

      const result = await handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      );

      expect(result.content[0].text).toContain('no more feedback');
      expect(result.content[0].text).toContain('no before copy');
    });

    it('leaves the text unchanged when listBaselines rejects', async () => {
      const client = makeReviewClient({
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockResolvedValue({
          status: 'batch',
          prompt: 'BATCH PROMPT',
          commentIds: ['c1'],
        }),
        getSessionFilePaths: vi.fn().mockResolvedValue(['/abs/a.md']),
        listBaselines: vi.fn().mockRejectedValue(new Error('network error')),
      });
      const openInBrowser = vi.fn().mockResolvedValue(undefined);

      const result = await handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      );

      expect(result.content[0].text).toContain('BATCH PROMPT');
      expect(result.content[0].text).not.toContain('no before copy');
    });
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
    expect(client.waitForAsk).toHaveBeenCalledWith('rev_xyz', 'ask_test', 90, undefined);
    expect(result.content[0].text).toContain('the answer');
    expect(result.content[0].text).toContain('questionIndex');
  });

  it('keeps polling through pending until the reply arrives (#131)', async () => {
    // Each poll is bounded at 90s so no single request outlasts Node's 300s
    // header timeout; a slow reader just means more polls.
    const waitForAsk = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'reply',
        replies: [{ questionIndex: 0, text: 'slow answer' }],
        totalQuestions: 1,
      });
    const client = makeMockClient({ waitForAsk });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: undefined },
    );

    expect(waitForAsk).toHaveBeenCalledTimes(3);
    for (const call of waitForAsk.mock.calls) {
      expect(call).toEqual(['rev_xyz', 'ask_test', 90, undefined]);
    }
    expect(result.content[0].text).toContain('slow answer');
  });

  it('stops polling once the call is cancelled, even if the release failed', async () => {
    const controller = new AbortController();
    // Answers on the fourth poll, so a loop that ignores the cancel fails the
    // call-count assertion below instead of spinning forever.
    let polls = 0;
    const waitForAsk = vi.fn().mockImplementation(async () => {
      polls += 1;
      controller.abort();
      return polls >= 4
        ? { status: 'reply', replies: [], totalQuestions: 1 }
        : { status: 'pending' };
    });
    const client = makeMockClient({
      waitForAsk,
      releaseAsk: vi.fn().mockRejectedValue(new Error('releaseAsk failed (HTTP 500)')),
    });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: controller.signal },
    );

    expect(waitForAsk).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('cancelled before the user could reply');
  });

  it('releases the ask before rethrowing when a poll fails, so the next mdr_ask is not blocked', async () => {
    const releaseAsk = vi.fn().mockResolvedValue(undefined);
    const client = makeMockClient({
      waitForAsk: vi.fn().mockRejectedValue(new Error('waitForAsk failed (HTTP 500)')),
      releaseAsk,
    });
    await expect(
      handleAskToolCall(
        { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
        { client, sendProgress: undefined, signal: undefined },
      ),
    ).rejects.toThrow('waitForAsk failed (HTTP 500)');
    expect(releaseAsk).toHaveBeenCalledWith('rev_xyz', 'ask_test');
  });

  it('gives a specific, non-generic error when the wait gives up because the server is unreachable', async () => {
    const releaseAsk = vi.fn().mockResolvedValue(undefined);
    const client = makeMockClient({
      waitForAsk: vi
        .fn()
        .mockRejectedValue(new ServerUnreachableError('http://localhost:5188', 'ECONNREFUSED')),
      releaseAsk,
    });
    const result = await handleAskToolCall(
      { sessionId: 'rev_xyz', questions: [{ filePath: '/x', anchor: 'a', text: 'q?' }] },
      { client, sendProgress: undefined, signal: undefined },
    );

    // A thrown ServerUnreachableError here is not returned to the caller;
    // the handler catches it and reports a result that says the question
    // may still be pending on the server, since postAgentComments already
    // succeeded before the wait itself lost the connection. Calling
    // mdr_ask again for the same question risks a duplicate post.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('still in the file');
    expect(result.content[0].text).toContain('do not call mdr_ask again');
    expect(releaseAsk).toHaveBeenCalledWith('rev_xyz', 'ask_test');
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
    expect(text).toContain('finished the review without replying');
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
    expect(client.waitForReview).toHaveBeenCalledWith('rev_1', 90, undefined);
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
    await handleWaitToolCall({ sessionId: 'rev_1' }, { client, sendProgress, signal: undefined });
    expect(sendProgress).toHaveBeenCalledWith(expect.stringContaining('rev_1'));
  });

  it('maps HTTP 404 to a graceful restart message instead of throwing', async () => {
    // Sessions are memory-only. After an mdr server restart, a parked
    // mdr_wait re-poll hits an unknown sessionId; the agent should get a
    // typed "re-read the file" result, not a raw HTTP error.
    const client = makeWaitClient({
      waitForReview: vi.fn().mockRejectedValue(new Error('waitForReview failed (HTTP 404)')),
    });
    const result = await handleWaitToolCall(
      { sessionId: 'rev_gone' },
      { client, sendProgress: undefined, signal: undefined },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('rev_gone');
    expect(result.content[0].text).toContain('Re-read');
  });
});

describe('handleReviewToolCall (fire-and-forget)', () => {
  function makeReviewClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn(),
      createSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi
        .fn()
        .mockResolvedValue({ commentsWritten: 2, repliesWritten: 0, commentIds: ['c1', 'c2'] }),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      captureBaseline: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('attaches to an existing session instead of creating one', async () => {
    const createSession = vi.fn();
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const grantAccess = vi.fn();
    const postReview = vi.fn().mockResolvedValue({ commentsWritten: 0, repliesWritten: 1 });
    const client = makeReviewClient({ createSession, grantAccess, postReview });

    const result = await handleReviewToolCall(
      {
        sessionId: 'rev_user_1',
        replies: [{ filePath: '/abs/a.md', commentId: 'cmt_1', text: 'ack', author: 'Claude' }],
      },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(createSession).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(grantAccess).not.toHaveBeenCalled();
    expect(postReview).toHaveBeenCalledWith('rev_user_1', {
      comments: undefined,
      replies: [{ filePath: '/abs/a.md', commentId: 'cmt_1', text: 'ack', author: 'Claude' }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('rev_user_1');
  });

  it('names the files it posted to when attaching by sessionId', async () => {
    const client = makeReviewClient({
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 1, repliesWritten: 1 }),
    });

    const result = await handleReviewToolCall(
      {
        sessionId: 'rev_user_1',
        comments: [{ filePath: '/abs/a.md', anchor: 'foo', text: 'bar' }],
        replies: [{ filePath: '/abs/b.md', commentId: 'cmt_1', text: 'ack' }],
      },
      {
        client,
        openInBrowser: vi.fn().mockResolvedValue(undefined),
        baseUrl: 'http://localhost:5188',
      },
    );

    expect(result.content[0].text).toContain('/abs/a.md');
    expect(result.content[0].text).toContain('/abs/b.md');
  });

  it('does not tell the agent to call mdr_wait on a session it did not open', async () => {
    // mdr_wait long-polls /agent-wait, which 409s on user-origin sessions.
    // The mdr_request_review handoff this form exists to serve IS user-origin,
    // so the creating form's nudge would send the flagship case into an error.
    const client = makeReviewClient({
      postReview: vi.fn().mockResolvedValue({ commentsWritten: 0, repliesWritten: 1 }),
    });

    const result = await handleReviewToolCall(
      {
        sessionId: 'rev_user_1',
        replies: [{ filePath: '/abs/a.md', commentId: 'cmt_1', text: 'ack' }],
      },
      {
        client,
        openInBrowser: vi.fn().mockResolvedValue(undefined),
        baseUrl: 'http://localhost:5188',
      },
    );

    const text = result.content[0].text;
    // The creating form's unconditional instruction must not appear verbatim.
    expect(text).not.toContain('When you have finished posting all feedback, call mdr_wait');
    // The user-origin continuation has to be named, since this form cannot
    // tell which kind of session it was handed.
    expect(text).toContain('mdr_request_review');
  });

  it('surfaces a post failure when attaching by sessionId', async () => {
    const client = makeReviewClient({
      postReview: vi.fn().mockRejectedValue(new Error('session not found or already finished')),
    });

    const result = await handleReviewToolCall(
      {
        sessionId: 'rev_gone',
        replies: [{ filePath: '/abs/a.md', commentId: 'cmt_1', text: 'ack' }],
      },
      {
        client,
        openInBrowser: vi.fn().mockResolvedValue(undefined),
        baseUrl: 'http://localhost:5188',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('session not found or already finished');
  });

  it('posts comments and returns immediately with sessionId and count', async () => {
    const client = makeReviewClient();
    const result = await handleReviewToolCall(
      {
        filePaths: ['/abs/a.md'],
        comments: [{ filePath: '/abs/a.md', anchor: 'foo', text: 'bar', author: 'Claude' }],
      },
      {
        client,
        openInBrowser: vi.fn().mockResolvedValue(undefined),
        baseUrl: 'http://localhost:5188',
      },
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
      createSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: false }),
    });
    await handleReviewToolCall(
      {
        filePaths: ['/abs/a.md'],
        comments: [{ filePath: '/abs/a.md', anchor: 'x', text: 'y', author: 'Claude' }],
      },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('opens the browser AT MOST ONCE per URL even if created=true is returned repeatedly', async () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined);
    const client = makeReviewClient({
      createSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1', created: true }),
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
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ commentIds: ['cmt_1'], commentsWritten: 1, repliesWritten: 0 }),
          { status: 201 },
        ),
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

describe('handleBaselineToolCall', () => {
  function makeClient(overrides: Partial<MdrClient> = {}): MdrClient {
    return {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn(),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
      postAgentComments: vi.fn(),
      waitForAsk: vi.fn(),
      postReview: vi.fn(),
      releaseAsk: vi.fn(),
      waitForReview: vi.fn(),
      captureBaseline: vi.fn(),
      ...overrides,
    } as MdrClient;
  }

  it('captures without a separate access check, and tells the agent what to do next', async () => {
    const client = makeClient({
      captureBaseline: vi.fn().mockResolvedValue({
        baselines: [
          { path: '/abs/a.md', capturedAt: 1, bytes: 10 },
          { path: '/abs/b.md', capturedAt: 1, bytes: 12 },
        ],
      }),
    });

    const result = await handleBaselineToolCall(
      { filePaths: ['/abs/a.md', '/abs/b.md'], agentName: 'Claude' },
      { client },
    );

    expect(client.grantAccess).not.toHaveBeenCalled();
    expect(client.captureBaseline).toHaveBeenCalledWith({
      filePaths: ['/abs/a.md', '/abs/b.md'],
      agentName: 'Claude',
    });
    const text = result.content[0].text;
    expect(text).toMatch(
      /^mdr_baseline: saved a before copy of 2 file\(s\): \/abs\/a\.md, \/abs\/b\.md\./,
    );
    expect(text).toContain('mdr_request_review');
    expect(text).toContain('sessionId');
  });

  it('surfaces a server error as the tool error', async () => {
    const client = makeClient({
      captureBaseline: vi.fn().mockRejectedValue(new Error('File not found: /abs/a.md')),
    });
    await expect(handleBaselineToolCall({ filePaths: ['/abs/a.md'] }, { client })).rejects.toThrow(
      'File not found: /abs/a.md',
    );
  });
});

describe('the mdr_add_files hint (#117)', () => {
  it('tells an agent posting on a file outside the session to add it first', async () => {
    const client = {
      postReview: vi
        .fn()
        .mockRejectedValue(new Error('comment 0: filePath not part of this session')),
    } as unknown as MdrClient;
    const result = await handleReviewToolCall(
      {
        sessionId: 'rev_1',
        comments: [{ filePath: '/d/b.md', anchor: 'x', text: 'y' }],
      },
      { client, openInBrowser: async () => {}, baseUrl: 'http://localhost:5188' },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Add the file to the session first with mdr_add_files',
    );
  });
});

describe('handleAddFilesToolCall (#117)', () => {
  function client(addSessionFiles: MdrClient['addSessionFiles']) {
    const calls: string[] = [];
    const grantAccess = vi.fn(async () => {
      calls.push('grant');
    });
    const add = vi.fn(async (...args: Parameters<MdrClient['addSessionFiles']>) => {
      calls.push('add');
      return addSessionFiles(...args);
    });
    return {
      calls,
      grantAccess,
      add,
      value: { grantAccess, addSessionFiles: add } as unknown as MdrClient,
    };
  }

  it('grants access before adding, and tells the agent how to carry on', async () => {
    const c = client(async () => ({
      sessionId: 'rev_1',
      filePaths: ['/d/a.md', '/d/b.md'],
      added: ['/d/b.md'],
    }));
    const result = await handleAddFilesToolCall(
      { sessionId: 'rev_1', filePaths: ['/d/b.md'] },
      { client: c.value },
    );

    expect(c.calls).toEqual(['grant', 'add']);
    expect(c.grantAccess).toHaveBeenCalledWith(['/d/b.md']);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('added /d/b.md to session rev_1');
    expect(result.content[0].text).toContain('now covers 2 file(s)');
    expect(result.content[0].text).toContain('Carry on with the same sessionId');
  });

  it('says nothing was added when the session already covers the files', async () => {
    const c = client(async () => ({ sessionId: 'rev_1', filePaths: ['/d/a.md'], added: [] }));
    const result = await handleAddFilesToolCall(
      { sessionId: 'rev_1', filePaths: ['/d/a.md'] },
      { client: c.value },
    );
    expect(result.content[0].text).toContain('already covers /d/a.md');
    expect(result.content[0].text).toContain('Nothing was added');
  });

  it.each([
    [404, 'Session not found'],
    [409, 'Session is not open'],
    [409, 'session closed'],
  ])('points at a new review on HTTP %i ("%s")', async (status, message) => {
    const c = client(async () => {
      throw Object.assign(new Error(message), { status });
    });
    const result = await handleAddFilesToolCall(
      { sessionId: 'rev_1', filePaths: ['/d/b.md'] },
      { client: c.value },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no longer open');
    expect(result.content[0].text).toContain('Start a new review');
  });

  it('blames an older server, not the session, for a 404 with no session error', async () => {
    // A server that predates the route 404s with a plain-text body, so the
    // client's message is the generic one.
    const c = client(async () => {
      throw Object.assign(new Error('addSessionFiles failed (HTTP 404)'), { status: 404 });
    });
    const result = await handleAddFilesToolCall(
      { sessionId: 'rev_1', filePaths: ['/d/b.md'] },
      { client: c.value },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('older than this mdr mcp');
    expect(result.content[0].text).not.toContain('no longer open');
  });

  it('passes any other failure through as the tool error', async () => {
    const c = client(async () => {
      throw new Error('Not a .md file: /d/notes.txt');
    });
    const result = await handleAddFilesToolCall(
      { sessionId: 'rev_1', filePaths: ['/d/notes.txt'] },
      { client: c.value },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('mdr_add_files: Not a .md file: /d/notes.txt');
  });
});
