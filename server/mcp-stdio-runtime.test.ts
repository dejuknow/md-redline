import { describe, it, expect, vi } from 'vitest';
import { handleRequestReviewToolCall } from './mcp-stdio';

describe('handleRequestReviewToolCall', () => {
  it('returns batch prompt with sessionId and continue instruction', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({
        status: 'batch',
        prompt: 'BATCH PROMPT',
        commentIds: ['c1', 'c2'],
      }),
      abortSession: vi.fn(),
    };
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
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({
        status: 'done',
        prompt: 'FINAL PROMPT',
      }),
      abortSession: vi.fn(),
    };
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('FINAL PROMPT');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('returns proceed message when user finishes with no comments', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockResolvedValue({ status: 'done' }),
      abortSession: vi.fn(),
    };
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('no more feedback');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('continue mode skips session creation and waits for next batch', async () => {
    const client = {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn().mockResolvedValue({
        status: 'batch',
        prompt: 'SECOND BATCH',
        commentIds: ['c3'],
      }),
      abortSession: vi.fn(),
    };
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
    expect(client.waitForSession).toHaveBeenCalledWith('rev_existing');
    expect(result.content[0].text).toContain('SECOND BATCH');
    expect(result.content[0].text).toContain('rev_existing');
  });

  it('continue mode returns done when user finishes', async () => {
    const client = {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn().mockResolvedValue({ status: 'done', prompt: 'FINAL' }),
      abortSession: vi.fn(),
    };
    const openInBrowser = vi.fn();

    const result = await handleRequestReviewToolCall(
      { mode: 'continue', sessionId: 'rev_existing' },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('FINAL');
    expect(result.content[0].text).not.toContain('mdr_request_review');
  });

  it('continue mode returns abort message when session is aborted', async () => {
    const client = {
      grantAccess: vi.fn(),
      createSession: vi.fn(),
      waitForSession: vi.fn().mockResolvedValue({ status: 'aborted', reason: 'user_cancelled' }),
      abortSession: vi.fn(),
    };
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
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi
        .fn()
        .mockResolvedValue({ status: 'done', prompt: 'X' }),
      abortSession: vi.fn(),
    };
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

      const client = {
        grantAccess: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
        waitForSession: vi.fn().mockReturnValue(waitPromise),
        abortSession: vi.fn(),
      };
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
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi
        .fn()
        .mockResolvedValue({ status: 'aborted', reason: 'user_cancelled' }),
      abortSession: vi.fn(),
    };
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
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi
        .fn()
        .mockResolvedValue({ status: 'aborted', reason: 'browser_disconnected' }),
      abortSession: vi.fn(),
    };
    const openInBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await handleRequestReviewToolCall(
      { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
      { client, openInBrowser, baseUrl: 'http://localhost:5188' },
    );

    expect(result.content[0].text).toContain('browser tab was closed');
  });

  it('throws on createSession failure with the underlying error message', async () => {
    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockRejectedValue(new Error('Access denied: outside roots')),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
    };
    const openInBrowser = vi.fn();

    await expect(
      handleRequestReviewToolCall(
        { mode: 'new', filePaths: ['/abs/a.md'], enableResolve: false },
        { client, openInBrowser, baseUrl: 'http://localhost:5188' },
      ),
    ).rejects.toThrow(/Access denied/);
  });

  it('throws on grantAccess failure with the underlying error message', async () => {
    const client = {
      grantAccess: vi
        .fn()
        .mockRejectedValue(new Error('Cannot grant access outside allowed directories')),
      createSession: vi.fn(),
      waitForSession: vi.fn(),
      abortSession: vi.fn(),
    };
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

    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockReturnValue(waitPromise),
      abortSession: vi.fn().mockImplementation(async (sessionId: string) => {
        expect(sessionId).toBe('rev_1');
        // Simulate the server resolving the long-poll once abort fires.
        resolveWait?.({ status: 'aborted', reason: 'user_cancelled' });
      }),
    };
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

  it('calls abortSession immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let resolveWait: ((r: { status: 'aborted'; reason: 'user_cancelled' }) => void) | undefined;
    const waitPromise = new Promise<{ status: 'aborted'; reason: 'user_cancelled' }>((r) => {
      resolveWait = r;
    });

    const client = {
      grantAccess: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'rev_1', url: '/?review=rev_1' }),
      waitForSession: vi.fn().mockReturnValue(waitPromise),
      abortSession: vi.fn().mockImplementation(async () => {
        resolveWait?.({ status: 'aborted', reason: 'user_cancelled' });
      }),
    };
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
