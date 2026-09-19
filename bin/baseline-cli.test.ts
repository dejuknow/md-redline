import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `mdr baseline` is what a Claude Code PreToolUse hook calls before every
// markdown edit. It must never fail the edit it runs in front of, so every
// case here asserts exit code 0 alongside whatever the server did or did not
// receive.
//
// Driven as a subprocess against a fake HTTP server, same shape as
// find-server-cli.test.ts: MD_REDLINE_PORT names the fake server directly, so
// findServerPort's probe order picks it first and never falls through to the
// port file or the scan range. That is also why this file has no "no server
// running" case: findServerPort (bin/cli.js) scans DEFAULT_SERVER_PORT and
// LEGACY_SERVER_PORT, ten ports each, whenever MD_REDLINE_PORT does not
// resolve to something answering: a case built to find nothing could instead
// find a developer's own mdr and post a baseline into it.
//
// One fake server for the whole file, started once and reused by every case,
// rather than one per test. find-server-cli.test.ts proves a running server
// can go missing by name (its "dead port" case binds an ephemeral port,
// closes it, and treats it as guaranteed unused); vitest runs test files
// concurrently, and a fresh listen(0) here can be handed that exact
// just-freed port before the other file's check runs. Fewer listen(0) calls
// in this file means fewer chances of landing on it.

const BIN = join(__dirname, 'md-redline');

interface BaselinesPostBody {
  filePaths: string[];
  onlyIfMissing?: boolean;
  agentName?: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let server: Server;
let serverPort: number;
let posts: BaselinesPostBody[] = [];
let postStatus = 200;

const children: ChildProcess[] = [];
let scratch: string | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ homeDir: '/tmp/fake-home' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/baselines') {
      let raw = '';
      req.on('data', (chunk) => (raw += String(chunk)));
      req.on('end', () => {
        posts.push(JSON.parse(raw || '{}'));
        res.writeHead(postStatus, { 'Content-Type': 'application/json' });
        res.end(
          postStatus >= 400
            ? JSON.stringify({ error: 'refused' })
            : JSON.stringify({ captured: [], kept: [] }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      serverPort = address.port;
      resolvePromise();
    });
  });
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  posts = [];
  postStatus = 200;
});

/** The scratch temp dir for this test, created on first use. */
function scratchDir(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'mdr-baseline-'));
  return scratch;
}

/** Run `mdr baseline`, naming the fake server via MD_REDLINE_PORT. */
function runCli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, 'baseline', ...args], {
      env: {
        ...process.env,
        MD_REDLINE_PORT: String(serverPort),
        PORT: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('mdr baseline --hook', () => {
  it('posts the hook file path with onlyIfMissing and no agentName', async () => {
    const docPath = join(scratchDir(), 'doc.md');

    const result = await runCli(
      ['--hook'],
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: docPath } }),
    );

    expect(result.code).toBe(0);
    expect(posts).toEqual([{ filePaths: [docPath], onlyIfMissing: true }]);
  });

  it('adds agentName when --agent is given', async () => {
    const docPath = join(scratchDir(), 'doc.md');

    const result = await runCli(
      ['--hook', '--agent', 'Claude'],
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: docPath } }),
    );

    expect(result.code).toBe(0);
    expect(posts).toEqual([{ filePaths: [docPath], onlyIfMissing: true, agentName: 'Claude' }]);
  });

  it('posts nothing and exits 0 for a non-markdown hook path', async () => {
    const tsPath = join(scratchDir(), 'doc.ts');

    const result = await runCli(
      ['--hook'],
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: tsPath } }),
    );

    expect(result.code).toBe(0);
    expect(posts).toEqual([]);
  });

  it('posts nothing and exits 0 when stdin is not JSON', async () => {
    const result = await runCli(['--hook'], 'not json');

    expect(result.code).toBe(0);
    expect(posts).toEqual([]);
  });
});

describe('mdr baseline <paths...>', () => {
  it('posts only the markdown path among explicit arguments', async () => {
    const mdPath = join(scratchDir(), 'a.md');
    const txtPath = join(scratchDir(), 'b.txt');

    const result = await runCli([mdPath, txtPath]);

    expect(result.code).toBe(0);
    expect(posts).toEqual([{ filePaths: [mdPath], onlyIfMissing: true }]);
  });

  it('posts a duplicate path once', async () => {
    const mdPath = join(scratchDir(), 'doc.md');

    const result = await runCli([mdPath, mdPath]);

    expect(result.code).toBe(0);
    expect(posts).toEqual([{ filePaths: [mdPath], onlyIfMissing: true }]);
  });

  it('exits 0 even when the server refuses the capture', async () => {
    postStatus = 500;
    const mdPath = join(scratchDir(), 'doc.md');

    const result = await runCli([mdPath]);

    expect(result.code).toBe(0);
    expect(posts).toEqual([{ filePaths: [mdPath], onlyIfMissing: true }]);
  });
});

describe('mdr baseline --hook --no-start (stdin regression)', () => {
  it('exits within 5s when the stdin pipe is opened and never closed', async () => {
    const child = spawn(process.execPath, [BIN, 'baseline', '--hook', '--no-start'], {
      env: {
        ...process.env,
        MD_REDLINE_PORT: String(serverPort),
        PORT: '',
      },
      // A real pipe, deliberately never written to and never ended: this is
      // what a hook runner that forgets to close its stdin leaves behind.
      // readStdin's own 2000ms timer must resolve AND stop listening, or the
      // open pipe keeps the event loop alive and the process never exits.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);

    const outcome = await new Promise<{ code: number | null; timedOut: boolean }>(
      (resolveOutcome) => {
        const timer = setTimeout(() => resolveOutcome({ code: null, timedOut: true }), 5000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolveOutcome({ code, timedOut: false });
        });
      },
    );

    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(0);
  }, 7000);
});
