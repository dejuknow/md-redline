import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  MAX_CLIENT_ID_LENGTH,
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
    expect((err as Error).message).toContain('re-read them before continuing');
  });

  it('says the server stopped while a long poll was waiting', async () => {
    // The mid-review case: mdr_wait is parked when the server goes down.
    const base = await listen((req) => setTimeout(() => req.socket.destroy(), 20));
    const err = await createMdrClient(base)
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
    const err = await createMdrClient(base)
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
});
