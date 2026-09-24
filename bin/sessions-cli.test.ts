import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `mdr sessions` against a fake server, driven the same way as
// find-server-cli.test.ts: MD_REDLINE_PORT names the fake, and a dead named
// port moves the fallback scan off 6373, so a real mdr on this machine is
// never listed or ended.

const BIN = join(__dirname, 'md-redline');
const HOME = '/home/reviewer';

const OPEN_SESSION = {
  id: 'rev_open',
  origin: 'agent',
  clientId: 'mcp_7f3e1a2b-0000-4000-8000-000000000000',
  filePaths: [`${HOME}/specs/a.md`],
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastHeartbeatAt: new Date(Date.now() - 10_000).toISOString(),
  status: 'open',
};

const servers: Server[] = [];
const children: ChildProcess[] = [];
let scratch: string | null = null;

/** Answers like mdr: /api/config for checkServer, the list, and abort. */
function startFakeServer(): Promise<{ port: number; aborted: string[] }> {
  const aborted: string[] = [];
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/config') return json(200, { homeDir: HOME });
      // Mirrors the real server's CSRF guard (server/index.ts), which refuses
      // any POST that is not application/json before a route ever runs.
      if (
        req.method === 'POST' &&
        !(req.headers['content-type'] ?? '').includes('application/json')
      ) {
        return json(415, { error: 'Content-Type must be application/json' });
      }
      if (req.method === 'GET' && req.url === '/api/review-sessions') {
        return json(200, { sessions: [OPEN_SESSION] });
      }
      const abort = /^\/api\/review-sessions\/([^/]+)\/abort$/.exec(req.url ?? '');
      if (req.method === 'POST' && abort) {
        const id = decodeURIComponent(abort[1]);
        if (id === 'rev_open') {
          aborted.push(id);
          return json(200, { ok: true });
        }
        if (id === 'rev_done') return json(409, { error: 'Session is not open' });
        return json(404, { error: 'Session not found' });
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      resolvePromise({ port: address.port, aborted });
    });
  });
}

/**
 * A port to name where nothing answers, on it or on the nine above it that
 * findServerPort also scans. Picked below every OS's ephemeral range (Linux
 * starts at 32768, macOS and Windows at 49152) because the fake servers other
 * test files start in parallel bind port 0 and land inside it. A free port
 * from inside that range failed on macOS CI: another file's fake server took a
 * neighbour, the scan found it, and the command reported it instead of "none".
 */
async function deadPortBlock(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 12_000);
    const free = await Promise.all(Array.from({ length: 10 }, (_, i) => portIsFree(base + i)));
    if (free.every(Boolean)) return base;
  }
  throw new Error('no free port block below the ephemeral range');
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)));
  });
}

function runSessions(
  args: string[],
  port: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  scratch ??= mkdtempSync(join(tmpdir(), 'mdr-sessions-'));
  const dir = scratch;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, 'sessions', ...args], {
      env: {
        ...process.env,
        // Keep the port file out of the real one's way, as in find-server-cli.
        TMPDIR: dir,
        TEMP: dir,
        TMP: dir,
        MD_REDLINE_PORT: String(port),
        PORT: '',
        MD_REDLINE_HOME: HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) =>
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('mdr sessions', () => {
  it('lists the open sessions the running server reports', async () => {
    const { port } = await startFakeServer();
    const { code, stdout } = await runSessions([], port);

    expect(code).toBe(0);
    expect(stdout).toContain('1 open review session');
    expect(stdout).toMatch(/rev_open\s+agent\s+mcp_7f3e1a2b\s+5m ago\s+10s ago\s+~\/specs\/a\.md/);
  });

  it('prints the server response untouched with --json', async () => {
    const { port } = await startFakeServer();
    const { code, stdout } = await runSessions(['--json'], port);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([OPEN_SESSION]);
  });

  it('reports that mdr is not running instead of starting it', async () => {
    const port = await deadPortBlock();

    const plain = await runSessions([], port);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("mdr isn't running, so no review sessions are open.");

    const json = await runSessions(['--json'], port);
    expect(JSON.parse(json.stdout)).toEqual([]);
  });

  it('ends a session with --kill', async () => {
    const { port, aborted } = await startFakeServer();
    const { code, stdout } = await runSessions(['--kill', 'rev_open'], port);

    expect(code).toBe(0);
    expect(stdout).toBe('Ended rev_open.');
    expect(aborted).toEqual(['rev_open']);
  });

  it.each([
    [['--kill', 'rev_nope'], 'no session rev_nope'],
    [['--kill=rev_done'], 'rev_done has already ended'],
    [['--kill'], '--kill needs a session ID'],
    [['--kill', '--json'], '--kill needs a session ID'],
    [['--bogus'], "unknown argument '--bogus'"],
  ])('exits 1 for %j', async (args, message) => {
    const { port, aborted } = await startFakeServer();
    const { code, stderr } = await runSessions(args, port);

    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(aborted).toEqual([]);
  });
});
