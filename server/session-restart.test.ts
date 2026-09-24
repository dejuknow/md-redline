/**
 * Proves review sessions survive a restart of the REAL server process, not
 * just the in-memory store (server/review-sessions.test.ts) or the file I/O
 * (server/session-persistence.test.ts). Every test here spawns a genuine
 * `node --import tsx server/index.ts` subprocess, sends it real signals, and
 * talks to it over real HTTP, because that is the only way to catch a bug at
 * the seam between those two already-tested pieces: the exact moment
 * index.ts wires persistence into the boot sequence (server/index.ts, the
 * isMainModule block).
 *
 * `node --import tsx`, not the `tsx` CLI (what `npm run dev:server` uses):
 * the CLI is itself a wrapper that spawns a second, separate node process to
 * actually run the script and relays signals to it. Killing the CLI's own
 * pid (what child_process.spawn would hand back) only kills the wrapper;
 * SIGKILL in particular never reaches the real worker, which then leaks as
 * an orphan still holding the port. `--import tsx` loads the same transform
 * as a loader hook in this one process, so the pid this test controls is the
 * pid actually listening.
 *
 * Every server here binds a random test port in 27000-28000 and an isolated
 * MD_REDLINE_HOME, and is killed by its own child PID in afterEach. Nothing
 * here can reach the port 6373 a developer's own `mdr` uses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer as createNetServer, connect } from 'net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMdrClient } from './mcp-stdio/client';
import { sessionsFilePath } from './session-persistence';
import type { WaitResult } from './mcp-stdio/types';

const REPO_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(__dirname, 'index.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port nothing is listening on, from the 27000-28000 block the task
 * reserves for these tests (clear of a developer's own mdr on 6373 and of
 * the ephemeral range other test files' fake servers bind into). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function pickTestPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 27_000 + Math.floor(Math.random() * 1_000);
    if (await portIsFree(port)) return port;
  }
  throw new Error('no free port found in the 27000-28000 test range');
}

/** Resolves once `port` accepts a TCP connection, without waiting for the
 * server to answer a request. Used by the request-gate test, which needs to
 * fire its request at the earliest moment a connection is even possible;
 * every other test uses waitForServerReady instead. */
function waitForPortOpen(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} never accepted a connection within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 20);
      });
    }
    attempt();
  });
}

/** Resolves once the server answers a real API request, which is later than
 * waitForPortOpen: a request that lands after the port is open but before
 * restore has finished is held open by index.ts's fetchAfterRestore gate,
 * not refused. On timeout, the error carries the child's own stdout/stderr,
 * since "never became ready" otherwise gives no clue which boot step hung. */
async function waitForServerReady(server: LaunchedServer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${server.baseUrl}/api/review-sessions`);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet; keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `server at ${server.baseUrl} never became ready within ${timeoutMs}ms; output:\n${server.output()}`,
      );
    }
    await sleep(20);
  }
}

interface LaunchedServer {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  output(): string;
}

let launchCount = 0;
const liveChildren: ChildProcess[] = [];
const scratchDirs: string[] = [];

/**
 * Spawn the real server on source, the same transform `npm run dev:server`
 * uses, so these tests exercise the actual boot sequence rather than a built
 * bundle that could be stale relative to the source (see
 * mcp-stdio-subprocess.test.ts's staleness guard, which this sidesteps by
 * not needing a build at all).
 */
function launchServer(opts: {
  port: number;
  homeDir: string;
  persistSessions?: boolean;
}): LaunchedServer {
  launchCount += 1;
  // tsx keeps a dev-mode IPC pipe at TMPDIR/tsx-<uid>/<pid>.pipe. A SIGKILLed
  // process (the SIGKILL test below) never gets to clean that file up, and
  // if the OS recycles its pid before the next launch, reusing the same
  // TMPDIR makes that launch fail with EADDRINUSE on the stale socket. A
  // fresh TMPDIR per launch, not just per test, keeps that path from ever
  // colliding, regardless of pid reuse.
  const tmpDir = mkdtempSync(join(tmpdir(), `mdr-restart-test-tmp-${launchCount}-`));
  scratchDirs.push(tmpDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MD_REDLINE_HOME: opts.homeDir,
    MD_REDLINE_PORT: String(opts.port),
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    NODE_ENV: 'test',
    // The update checker would otherwise fire a real network request on
    // every boot; these tests care about session restore, not that.
    NO_UPDATE_NOTIFIER: '1',
  };
  if (opts.persistSessions === false) {
    env.MD_REDLINE_PERSIST_SESSIONS = '0';
  } else {
    delete env.MD_REDLINE_PERSIST_SESSIONS;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  liveChildren.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  return { child, port: opts.port, baseUrl: `http://127.0.0.1:${opts.port}`, output: () => output };
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('server process did not exit in time')),
      timeoutMs,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Send `signal` and wait for the process to actually exit, so a relaunch on
 * the same port never races the old process's socket release. */
async function stopServer(
  server: LaunchedServer,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = waitForExit(server.child);
  server.child.kill(signal);
  return exited;
}

/** A fresh home dir seeded with one reviewable file, and trusted by default
 * (server/index.ts's defaultTrustHome) on its first boot since a temp dir
 * never has a pre-existing .md-redline preferences file. */
function makeHomeDir(): { homeDir: string; docPath: string } {
  const homeDir = mkdtempSync(join(tmpdir(), 'mdr-restart-test-home-'));
  scratchDirs.push(homeDir);
  const docPath = join(homeDir, 'doc.md');
  writeFileSync(docPath, '# Doc\n\nSome body text.\n');
  return { homeDir, docPath };
}

async function createSession(baseUrl: string, filePath: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/review-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePaths: [filePath], origin: 'user' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

afterEach(async () => {
  // A test that fails partway through must not leak a listening server into
  // the next test, or into the developer's own machine. SIGKILL is fine here
  // even for the graceful-shutdown tests: by the time afterEach runs, those
  // servers have already been stopped on purpose, and killing an already-
  // dead child is a no-op.
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await sleep(100);
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('a review session survives a real server restart (#116)', () => {
  it('SIGTERM: a parked wait reconnects after relaunch and receives a batch sent through the real route', async () => {
    const { homeDir, docPath } = makeHomeDir();
    const port = await pickTestPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverA = launchServer({ port, homeDir });
    await waitForServerReady(serverA, 10_000);

    const sessionId = await createSession(baseUrl, docPath);

    // Park a long poll through the real MCP client, the same way an agent
    // reconnecting after a restart would. Don't await it yet: the point is
    // that it survives the server going away out from under it.
    const client = createMdrClient(baseUrl);
    const waitPromise = client.waitForSession(sessionId, 30);
    // Give the request time to actually reach the server and park before
    // killing it, so this exercises a poll caught mid-flight rather than
    // one that never got sent.
    await sleep(200);

    await stopServer(serverA, 'SIGTERM');

    const serverB = launchServer({ port, homeDir });
    await waitForServerReady(serverB, 10_000);

    const listRes = await fetch(`${baseUrl}/api/review-sessions`);
    const listed = (await listRes.json()) as { sessions: Array<{ id: string }> };
    expect(listed.sessions.map((s) => s.id)).toContain(sessionId);

    // The reader's "Send to agent" action, against the relaunched server.
    const batchRes = await fetch(`${baseUrl}/api/review-sessions/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Please address these', commentIds: ['c1'] }),
    });
    expect(batchRes.status).toBe(200);

    const result: WaitResult = await waitPromise;
    expect(result.status).toBe('batch');
    if (result.status === 'batch') {
      expect(result.commentIds).toEqual(['c1']);
      expect(result.prompt.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('the request gate: the first request after the port opens gets 200, not 404, while restore is still in flight', async () => {
    const { homeDir, docPath } = makeHomeDir();
    const port = await pickTestPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverA = launchServer({ port, homeDir });
    await waitForServerReady(serverA, 10_000);
    const sessionId = await createSession(baseUrl, docPath);

    await stopServer(serverA, 'SIGTERM');

    // Not captured: this test deliberately never calls waitForServerReady
    // on it, since the whole point is to fire the very next line as early
    // as possible rather than wait for full readiness first.
    launchServer({ port, homeDir });
    // Fire the request the instant the port accepts a connection, not once
    // the server is confirmed ready: index.ts's fetchAfterRestore is
    // supposed to hold this request open until restore finishes rather
    // than route it into a store that doesn't have the session back yet.
    // Waiting for readiness first would never be able to catch a
    // regression of that gate.
    await waitForPortOpen(port, 10_000);
    const res = await fetch(`${baseUrl}/api/review-sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(sessionId);
  }, 20_000);

  it('SIGKILL: a change saved by the debounced writer (not a graceful shutdown) survives too', async () => {
    const { homeDir, docPath } = makeHomeDir();
    const port = await pickTestPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverA = launchServer({ port, homeDir });
    await waitForServerReady(serverA, 10_000);
    const sessionId = await createSession(baseUrl, docPath);

    // A second file added is itself a saved-state change (addFiles is one
    // of the onChange triggers), so this proves an update, not just the
    // initial create, reaches disk without a graceful shutdown to flush it.
    const secondDoc = join(homeDir, 'second.md');
    writeFileSync(secondDoc, '# Second\n\nMore body text.\n');
    const addRes = await fetch(`${baseUrl}/api/review-sessions/${sessionId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePaths: [secondDoc] }),
    });
    expect(addRes.status).toBe(200);

    // Past the 250ms debounce, with slack for the async write itself to
    // land, since SIGKILL gives the process no chance to flush on exit.
    await sleep(450);

    await stopServer(serverA, 'SIGKILL');

    const serverB = launchServer({ port, homeDir });
    await waitForServerReady(serverB, 10_000);

    const getRes = await fetch(`${baseUrl}/api/review-sessions/${sessionId}`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { filePaths: string[] };
    // The server canonicalizes paths with realpath (server/index.ts's
    // resolveAndValidate), which on macOS rewrites /var/folders/... (what
    // os.tmpdir() returns) to /private/var/folders/...; realpath it here too
    // rather than asserting against the raw path this test sent.
    expect(body.filePaths).toContain(realpathSync(secondDoc));
  }, 20_000);

  it('a saved file older than the restore window is discarded, and the server still starts cleanly', async () => {
    const { homeDir, docPath } = makeHomeDir();
    const port = await pickTestPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverA = launchServer({ port, homeDir });
    await waitForServerReady(serverA, 10_000);
    const sessionId = await createSession(baseUrl, docPath);

    // Graceful stop so the file is guaranteed to exist before this rewrites
    // it, without needing to wait out the debounce first.
    await stopServer(serverA, 'SIGTERM');

    const savedPath = sessionsFilePath(homeDir, port);
    const saved = JSON.parse(readFileSync(savedPath, 'utf8')) as { savedAt: number };
    saved.savedAt = Date.now() - 10 * 60_000;
    writeFileSync(savedPath, JSON.stringify(saved));

    const serverB = launchServer({ port, homeDir });
    await waitForServerReady(serverB, 10_000);

    const getRes = await fetch(`${baseUrl}/api/review-sessions/${sessionId}`);
    expect(getRes.status).toBe(404);

    // "Started cleanly" means more than just answering 404 for the gone
    // session: the list route works too, with nothing carried over.
    const listRes = await fetch(`${baseUrl}/api/review-sessions`);
    expect(listRes.status).toBe(200);
    expect((await listRes.json()) as { sessions: unknown[] }).toEqual({ sessions: [] });
  }, 20_000);

  it('MD_REDLINE_PERSIST_SESSIONS=0: a relaunch neither restores a session nor writes a file', async () => {
    const { homeDir, docPath } = makeHomeDir();
    const port = await pickTestPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverA = launchServer({ port, homeDir, persistSessions: false });
    await waitForServerReady(serverA, 10_000);
    const sessionId = await createSession(baseUrl, docPath);

    // Long enough that, if persistence were mistakenly still wired up, its
    // debounced writer would have fired by now.
    await sleep(450);

    await stopServer(serverA, 'SIGTERM');

    const savedPath = sessionsFilePath(homeDir, port);
    expect(existsSync(savedPath)).toBe(false);

    const serverB = launchServer({ port, homeDir, persistSessions: false });
    await waitForServerReady(serverB, 10_000);

    const getRes = await fetch(`${baseUrl}/api/review-sessions/${sessionId}`);
    expect(getRes.status).toBe(404);
    expect(existsSync(savedPath)).toBe(false);
  }, 20_000);
});
