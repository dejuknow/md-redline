import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Subprocess smoke test for the CLI's update notice. bin/md-redline prints
// "Update available: ..." when the running server reports a newer `latest`
// than this CLI's own version, and stays silent otherwise. That wiring was
// previously verified only by hand.
//
// The stub server below satisfies bin/server-control.js's checkServer probe
// (GET /api/config -> 2xx with a JSON body whose `homeDir` is a string) so
// the CLI takes the "existing server" path and never spawns a real one.

const BIN = join(__dirname, 'md-redline');
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};
const CLI_VERSION = PKG.version;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function jsonBody(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Stub server for the CLI's "existing server" path. Serves exactly what
 * bin/server-control.js's checkServer requires on /api/config, plus the
 * /api/version, /api/shutdown, and /api/grant-access endpoints the CLI's
 * main flow touches. Everything else is a harmless 200 JSON `{}` so any
 * other probe the CLI happens to make does not blow up the run.
 */
function startStub(versionResponse: Record<string, unknown>): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/config') {
        // checkServer requires response.ok (2xx) and a JSON body with a
        // string `homeDir` field; anything else and it reports not-running.
        jsonBody(res, 200, { homeDir: '/tmp/mdr-stub-home' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/version') {
        jsonBody(res, 200, versionResponse);
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/api/shutdown' || url.pathname === '/api/grant-access')) {
        req.resume();
        req.on('end', () => jsonBody(res, 200, { ok: true }));
        return;
      }

      req.resume();
      req.on('end', () => jsonBody(res, 200, {}));
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('stub server did not report a port'));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}

function closeStub(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    // Force-close any lingering keep-alive sockets rather than waiting on
    // them, so teardown cannot hang past the CLI subprocess's own exit.
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
}

/** No-op `open` on PATH so the CLI's openInBrowser() never launches a real browser. */
function createOpenStub(dir: string): void {
  const scriptPath = join(dir, 'open');
  writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n');
  chmodSync(scriptPath, 0o755);
}

function buildEnv(stubPort: number, isolatedTmp: string, openBinDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Isolates the port file the CLI reads/writes under tmpdir() so this
    // run never sees (or clobbers) a real md-redline.port from the dev box.
    TMPDIR: isolatedTmp,
    // The CLI's port scan starts here, landing straight on the stub.
    MD_REDLINE_PORT: String(stubPort),
    // Shadow the real `open` so the run never launches a browser.
    PATH: `${openBinDir}:${process.env.PATH ?? ''}`,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      resolvePromise({ stdout, stderr, code });
    });
  });
}

describe('mdr update notice (subprocess)', () => {
  let stubServer: Server | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (stubServer) {
      await closeStub(stubServer);
      stubServer = undefined;
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('prints an update notice on stdout when the server reports a newer version', async () => {
    const { server, port } = await startStub({ version: CLI_VERSION, latest: '99.0.0' });
    stubServer = server;

    const isolatedTmp = freshTempDir('mdr-update-notice-tmp-');
    const openBinDir = freshTempDir('mdr-update-notice-bin-');
    const mdFileDir = freshTempDir('mdr-update-notice-md-');
    createOpenStub(openBinDir);
    const mdFile = join(mdFileDir, 'spec.md');
    writeFileSync(mdFile, '# Test spec\n');

    const result = await runCli([mdFile], buildEnv(port, isolatedTmp, openBinDir));

    expect(
      result.stdout,
      `expected update notice; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toContain(`Update available: ${CLI_VERSION} -> 99.0.0. Run: npm install -g md-redline@latest`);
    expect(result.code).toBe(0);
  }, 15_000);

  it('prints no update notice on stdout when the server has no newer version', async () => {
    const { server, port } = await startStub({ version: CLI_VERSION });
    stubServer = server;

    const isolatedTmp = freshTempDir('mdr-update-notice-tmp-');
    const openBinDir = freshTempDir('mdr-update-notice-bin-');
    const mdFileDir = freshTempDir('mdr-update-notice-md-');
    createOpenStub(openBinDir);
    const mdFile = join(mdFileDir, 'spec.md');
    writeFileSync(mdFile, '# Test spec\n');

    const result = await runCli([mdFile], buildEnv(port, isolatedTmp, openBinDir));

    expect(
      result.stdout,
      `expected no update notice; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).not.toContain('Update available:');
    expect(result.code).toBe(0);
  }, 15_000);
});
