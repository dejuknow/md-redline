import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  MAX_CLIENT_ID_LENGTH,
  RECONNECT_WINDOW_MS,
  ServerUnreachableError,
  createMdrClient,
  resolveClientId,
  toServerError,
} from './client';

describe('resolveClientId', () => {
  it('uses a fresh per-process id when MD_REDLINE_CLIENT_ID is unset or blank', () => {
    for (const env of [{}, { MD_REDLINE_CLIENT_ID: '' }, { MD_REDLINE_CLIENT_ID: '   ' }]) {
      expect(resolveClientId(env)).toMatch(/^mcp_[0-9a-f-]{36}$/);
    }
    expect(resolveClientId({})).not.toBe(resolveClientId({}));
  });

  it('uses the value a per-call client sets, trimmed, so every call shares it', () => {
    expect(resolveClientId({ MD_REDLINE_CLIENT_ID: '  review-42 ' })).toBe('review-42');
  });

  it('accepts the longest value the server accepts and rejects one past it at startup', () => {
    const longest = 'x'.repeat(MAX_CLIENT_ID_LENGTH);
    expect(resolveClientId({ MD_REDLINE_CLIENT_ID: longest })).toBe(longest);
    expect(() => resolveClientId({ MD_REDLINE_CLIENT_ID: `${longest}x` })).toThrow(
      /MD_REDLINE_CLIENT_ID is 257 characters; the limit is 256/,
    );
  });
});

describe('a server that is gone (#116)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      }),
    );
  }

  /**
   * A port nothing listens on, picked below every OS's ephemeral range. A port
   * freed from inside that range can be taken by a fake server another test
   * file starts in parallel, which made a CLI test flaky on macOS CI.
   */
  async function freeBaseUrl(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = 20_000 + Math.floor(Math.random() * 12_000);
      const free = await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
      });
      if (free) return `http://127.0.0.1:${port}`;
    }
    throw new Error('no free port below the ephemeral range');
  }

  it('says the server is not running, and what to do, instead of a bare fetch failed', async () => {
    const base = await freeBaseUrl();
    const err = await createMdrClient(base)
      .getSessionFilePaths('rev_x')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServerUnreachableError);
    expect((err as ServerUnreachableError).code).toBe('ECONNREFUSED');
    expect((err as Error).message).toContain(`The mdr server at ${base} is not running`);
    // The message no longer blanket-tells every caller to "call this tool
    // again": that is wrong for a call that had already posted something,
    // where the post may have landed before the connection dropped.
    expect((err as Error).message).toContain('call it again');
    expect((err as Error).message).toContain('re-read the file');
  });

  it('says the server stopped while a long poll was waiting', async () => {
    // The mid-review case: mdr_wait is parked when the server goes down.
    // reconnectWindowMs: 0 means the very first failure is already past the
    // window, so this stays a single-attempt test of the error itself rather
    // than a (#116) reconnect test.
    const base = await listen((req) => setTimeout(() => req.socket.destroy(), 20));
    const err = await createMdrClient(base, { reconnectWindowMs: 0 })
      .waitForReview('rev_x', 90)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServerUnreachableError);
    expect((err as Error).message).toContain('lost its connection to this call (UND_ERR_SOCKET)');
  });

  it('says the same when the connection drops while the response body is arriving', async () => {
    // Headers sent, then the server dies mid-body: fetch resolves, and the
    // failure only shows up in the body read, which the wrapper must cover too.
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"status": "do');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    // waitForReview reads the body without a catch; getSessionFilePaths would
    // swallow the failure by design and return [].
    // reconnectWindowMs: 0, as above: this test is about the error shape, not
    // the retry loop.
    const err = await createMdrClient(base, { reconnectWindowMs: 0 })
      .waitForReview('rev_x', 90)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServerUnreachableError);
  });

  it('never calls a client-side timeout or an unknown network code the server being gone', () => {
    // mdr_ask's wait has no server-side limit, so a slow reply can hit
    // undici's header timeout while the server and the review are fine.
    for (const code of [
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'ETIMEDOUT',
      undefined,
    ]) {
      const err = new TypeError('fetch failed', { cause: { code } });
      expect(toServerError(err, 'http://x')).toBe(err);
    }
  });

  it("leaves a caller's own abort, and anything that is not a network failure, alone", async () => {
    const base = await listen(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const abort = await fetch(`${base}/x`, { signal: controller.signal }).catch((e: unknown) => e);
    // Guard for the test itself: this is the real error an abort produces.
    expect((abort as Error).name).toBe('AbortError');

    expect(toServerError(abort, base)).toBe(abort);
    const other = new TypeError('something else');
    expect(toServerError(other, base)).toBe(other);
  });

  it('keeps HTTP errors as they were: the server answered, so it is not gone', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    });
    const err = await createMdrClient(base)
      .waitForReview('rev_x', 90)
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(ServerUnreachableError);
    expect((err as Error).message).toBe('waitForReview failed (HTTP 404): Session not found');
  });

  describe('reconnecting through a restart (#116)', () => {
    it('exports a two-minute default window', () => {
      expect(RECONNECT_WINDOW_MS).toBe(2 * 60 * 1000);
    });

    it('retries a long poll on ServerUnreachableError and returns once the server answers', async () => {
      // The first two requests land on a server that has stopped responding
      // (a restart in progress); the third lands after it is back up. A
      // single handler serving every attempt is closer to the real restart
      // than swapping servers mid-test, and avoids reusing a port.
      let attempts = 0;
      const base = await listen((req, res) => {
        attempts += 1;
        if (attempts <= 2) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'done' }));
      });

      const result = await createMdrClient(base).waitForReview('rev_x', 90);

      expect(result).toEqual({ status: 'done' });
      expect(attempts).toBe(3);
    }, 8_000);

    it('retries an ask wait and a session wait the same way', async () => {
      let askAttempts = 0;
      const askBase = await listen((req, res) => {
        askAttempts += 1;
        if (askAttempts === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'no_reply', reason: 'released' }));
      });
      const askResult = await createMdrClient(askBase).waitForAsk('rev_x', 'ask_1', 90);
      expect(askResult).toEqual({ status: 'no_reply', reason: 'released' });
      expect(askAttempts).toBe(2);

      let sessionAttempts = 0;
      const sessionBase = await listen((req, res) => {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'done' }));
      });
      const sessionResult = await createMdrClient(sessionBase).waitForSession('rev_x', 90);
      expect(sessionResult).toEqual({ status: 'done' });
      expect(sessionAttempts).toBe(2);
    }, 8_000);

    it('gives up and rethrows once the reconnect window has passed', async () => {
      let attempts = 0;
      const base = await listen((req) => {
        attempts += 1;
        req.socket.destroy();
      });

      // Short injected window (RECONNECT_WINDOW_MS is 2 minutes in
      // production) so this test proves the give-up path without waiting it
      // out for real.
      const err = await createMdrClient(base, { reconnectWindowMs: 1_500 })
        .waitForReview('rev_x', 90)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServerUnreachableError);
      // At least one retry happened before the window closed.
      expect(attempts).toBeGreaterThanOrEqual(2);
    }, 8_000);

    it("never runs past the poll's own deadline, and retries ask only for the time left", async () => {
      // A restart mid-poll used to stack a fresh full-length poll on a
      // two-minute retry, so one tool call could outlast an MCP host's limit.
      const urls: string[] = [];
      const base = await listen((req) => {
        urls.push(req.url ?? '');
        req.socket.destroy();
      });

      const started = Date.now();
      const err = await createMdrClient(base)
        .waitForReview('rev_x', 3)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServerUnreachableError);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(urls[0]).toContain('timeout=3');
      const later = urls.slice(1).map((u) => Number(/timeout=(\d+)/.exec(u)?.[1]));
      expect(later.length).toBeGreaterThan(0);
      for (const t of later) expect(t).toBeLessThanOrEqual(2);
    }, 8_000);

    it('does not retry a non-poll method on ServerUnreachableError', async () => {
      let attempts = 0;
      const base = await listen((req) => {
        attempts += 1;
        req.socket.destroy();
      });

      const err = await createMdrClient(base)
        .abortSession('rev_x')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServerUnreachableError);

      // Give a wrongly-retrying implementation time to have made a second
      // request before asserting only one ever happened.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(attempts).toBe(1);
    }, 8_000);

    it('stops retrying within ~100ms of the signal aborting, instead of sleeping out the poll interval', async () => {
      let attempts = 0;
      const base = await listen((req) => {
        attempts += 1;
        req.socket.destroy();
      });

      const controller = new AbortController();
      // Aborts partway through the 1s sleep between the first failed
      // attempt and the next retry (RECONNECT_POLL_INTERVAL_MS), so a fix
      // that only checks the signal before sleeping, not during it, would
      // still fail this.
      setTimeout(() => controller.abort(), 30);

      const started = Date.now();
      const err = await createMdrClient(base)
        .waitForReview('rev_x', 90, controller.signal)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServerUnreachableError);
      expect(Date.now() - started).toBeLessThan(200);
      expect(attempts).toBeGreaterThanOrEqual(1);
    }, 8_000);
  });
});
