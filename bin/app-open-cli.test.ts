import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// Subprocess test for the CLI's hand-off to the mdr desktop app on macOS:
// `mdr foo.md` first runs `open mdr://open?file=...`, and when that fails (no
// app has registered the scheme) opens the browser with the exact URL. A fake
// `open` first on PATH records each call, so the run never reaches a real app
// or browser. macOS only, since the hand-off is.
//
// The stub server listens inside the app's scan range (6373-6382), is found
// through the port file rather than a named port, and serves a scratch HOME:
// the one setup in which the CLI prefers the app. MD_REDLINE_PORT, PORT or
// another MD_REDLINE_HOME would send it straight to the browser.

const BIN = join(__dirname, 'md-redline');
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

function startStub(homeDir: string): Promise<{ server: Server; port: number }> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body: unknown = {};
    if (url.pathname === '/api/config') body = { homeDir };
    if (url.pathname === '/api/version') body = { version: PKG.version };
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  };
  // From the top of the range down, away from a developer's live 6373.
  const tryPort = (port: number): Promise<{ server: Server; port: number }> =>
    new Promise((resolvePromise, reject) => {
      const server = createServer(handler);
      server.once('error', (err) => {
        if (port > 6374) resolvePromise(tryPort(port - 1));
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolvePromise({ server, port }));
    });
  return tryPort(6382);
}

/** A fake macOS `open`: appends each argument to `log`, refusing mdr:// links when `refuseApp`. */
function writeFakeOpen(binDir: string, log: string, refuseApp: boolean): void {
  const fake = join(binDir, 'open');
  const refuse = refuseApp ? 'case "$1" in mdr:*) exit 1 ;; esac\n' : '';
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n${refuse}exit 0\n`);
  chmodSync(fake, 0o755);
}

async function readLog(log: string, lines: number, waitMs = 5_000): Promise<string[]> {
  // The browser fallback spawns `open` detached, so its line can land after
  // the CLI has exited.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    if (got.length >= lines || Date.now() > deadline) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.runIf(process.platform === 'darwin')('mdr hands opens to the desktop app', () => {
  let stub: Server | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    if (stub) {
      stub.closeAllConnections();
      await new Promise<void>((r) => stub?.close(() => r()));
      stub = undefined;
    }
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  async function runCli(refuseApp: boolean) {
    const scratch = mkdtempSync(join(tmpdir(), 'mdr-app-open-'));
    dirs.push(scratch);
    const home = mkdtempSync(join(scratch, 'home-'));
    const tmp = mkdtempSync(join(scratch, 'tmp-'));
    const bin = mkdtempSync(join(scratch, 'bin-'));
    const log = join(scratch, 'open.log');
    writeFakeOpen(bin, log, refuseApp);
    const doc = join(home, 'spec.md');
    writeFileSync(doc, '# Spec\n');

    const started = await startStub(home);
    stub = started.server;
    // The port file is the CLI's fast path to the stub.
    writeFileSync(join(tmp, 'md-redline.port'), String(started.port));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      TMPDIR: tmp,
      MD_REDLINE_HOME: '',
      MD_REDLINE_PORT: '',
      PORT: '',
      MD_REDLINE_BROWSER: '',
      MDR_BROWSER: '',
    };
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, doc], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', () => resolvePromise(out));
    });
    return { stdout, log, doc, port: started.port };
  }

  it('falls back to the browser with the exact URL when no app takes the link', async () => {
    const { stdout, log, doc, port } = await runCli(true);
    const calls = await readLog(log, 2);
    expect(calls[0]).toBe(`mdr://open?file=${encodeURIComponent(doc)}`);
    expect(calls[1]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/?\\?file=`));
    expect(calls).toHaveLength(2);
    expect(stdout).toContain('Opened in browser:');
  }, 15_000);

  it('stops at the app when it takes the link', async () => {
    const { stdout, log, doc } = await runCli(false);
    // Wait a moment for a browser call that should never come.
    const calls = await readLog(log, 2, 1_000);
    expect(calls).toEqual([`mdr://open?file=${encodeURIComponent(doc)}`]);
    expect(stdout).toContain('Opened in mdr:');
  }, 15_000);
});
