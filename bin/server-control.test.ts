import { describe, expect, it, vi } from 'vitest';

import {
  buildKillCommand,
  checkServer,
  gracefulShutdown,
  killPort,
} from './server-control.js';

describe('buildKillCommand', () => {
  it('scopes lsof to LISTEN state on macOS/Linux', () => {
    const cmd = buildKillCommand(3001, 'darwin');
    expect(cmd).toContain('lsof -iTCP:3001 -sTCP:LISTEN -t');
    expect(cmd).toContain('xargs kill');
  });

  it('uses netstat LISTENING filter on Windows', () => {
    const cmd = buildKillCommand(3001, 'win32');
    expect(cmd).toBe('netstat -ano | findstr :3001 | findstr LISTENING');
  });

  it('returns null for non-integer, zero, negative, or out-of-range ports', () => {
    expect(buildKillCommand(0, 'darwin')).toBeNull();
    expect(buildKillCommand(-1, 'darwin')).toBeNull();
    expect(buildKillCommand(65_536, 'darwin')).toBeNull();
    expect(buildKillCommand(3.5 as unknown as number, 'darwin')).toBeNull();
  });
});

describe('killPort', () => {
  it('invokes the lsof LISTEN-scoped command on macOS', () => {
    const exec = vi.fn();
    const ok = killPort(3001, { platform: 'darwin', exec });
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('lsof -iTCP:3001 -sTCP:LISTEN -t'),
      expect.anything(),
    );
  });

  it('returns false for invalid ports without shelling out', () => {
    const exec = vi.fn();
    expect(killPort(0, { platform: 'darwin', exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns false when exec throws and swallows the error', () => {
    const exec = vi.fn(() => {
      throw new Error('boom');
    });
    expect(killPort(3001, { platform: 'darwin', exec })).toBe(false);
  });

  it('on Windows parses netstat output and invokes taskkill per PID', () => {
    const netstatOutput = [
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       4242',
      '  TCP    [::]:3001              [::]:0                 LISTENING       4242',
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       4243',
    ].join('\n');
    const exec = vi.fn((cmd: string) => {
      if (cmd.startsWith('netstat')) return netstatOutput;
      return '';
    });
    const ok = killPort(3001, { platform: 'win32', exec });
    expect(ok).toBe(true);
    const taskkillCalls = exec.mock.calls
      .map((c) => String(c[0]))
      .filter((c) => c.startsWith('taskkill'));
    expect(taskkillCalls).toEqual(
      expect.arrayContaining([
        'taskkill /PID 4242 /F',
        'taskkill /PID 4243 /F',
      ]),
    );
    // Deduped — only two unique PIDs despite three lines.
    expect(taskkillCalls).toHaveLength(2);
  });
});

function mkResponse(ok: boolean, status = ok ? 200 : 500): Response {
  return { ok, status } as unknown as Response;
}

describe('checkServer', () => {
  it('returns true on 2xx', async () => {
    const fetchFn = vi.fn(async () => mkResponse(true));
    await expect(checkServer(3001, { fetchFn })).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3001/api/config',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns false on non-2xx', async () => {
    const fetchFn = vi.fn(async () => mkResponse(false, 500));
    await expect(checkServer(3001, { fetchFn })).resolves.toBe(false);
  });

  it('returns false when fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(checkServer(3001, { fetchFn })).resolves.toBe(false);
  });
});

describe('gracefulShutdown', () => {
  it('returns true when the server stops responding after /api/shutdown', async () => {
    const fetchFn = vi.fn(async () => mkResponse(true));
    const checkServerFn = vi.fn(async () => false);
    const now = vi.fn(() => 0);
    const delay = vi.fn(async () => {});
    const result = await gracefulShutdown(3001, {
      fetchFn,
      checkServerFn,
      now,
      delay,
    });
    expect(result).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3001/api/shutdown',
      expect.objectContaining({
        method: 'POST',
        // Server middleware 415s POSTs without this header.
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(checkServerFn).toHaveBeenCalledTimes(1);
  });

  it('treats a fetch rejection as a possible success and polls for server exit', async () => {
    // Reproduces the upgrade race: server responds to /api/shutdown, calls
    // setImmediate(process.exit), socket is cut before fetch fully resolves.
    // gracefulShutdown must NOT return false here — otherwise the caller
    // falls back to killPort while the server is still momentarily alive.
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    let ticks = 0;
    const checkServerFn = vi.fn(async () => {
      ticks += 1;
      return ticks < 2; // alive once, gone on second poll
    });
    const now = vi.fn(() => 0);
    const delay = vi.fn(async () => {});
    const result = await gracefulShutdown(3001, {
      fetchFn,
      checkServerFn,
      now,
      delay,
    });
    expect(result).toBe(true);
    expect(checkServerFn).toHaveBeenCalledTimes(2);
  });

  it('returns false when the server acknowledges but never actually stops within deadline', async () => {
    const fetchFn = vi.fn(async () => mkResponse(true));
    const checkServerFn = vi.fn(async () => true); // still alive forever
    let clock = 0;
    const now = vi.fn(() => clock);
    const delay = vi.fn(async () => {
      clock += 250;
    });
    const result = await gracefulShutdown(3001, {
      fetchFn,
      checkServerFn,
      deadlineMs: 1_000,
      pollMs: 250,
      now,
      delay,
    });
    expect(result).toBe(false);
    expect(checkServerFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns false on non-2xx response (e.g. old server without /api/shutdown)', async () => {
    const fetchFn = vi.fn(async () => mkResponse(false, 404));
    const checkServerFn = vi.fn(async () => false);
    const result = await gracefulShutdown(3001, {
      fetchFn,
      checkServerFn,
      now: () => 0,
      delay: async () => {},
    });
    expect(result).toBe(false);
    // Shouldn't have polled — we bailed early on explicit failure.
    expect(checkServerFn).not.toHaveBeenCalled();
  });
});
