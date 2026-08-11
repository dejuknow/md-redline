import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Which running server a command acts on. Every command that needs one picks it
// through findServerPort, and picking the wrong one is not a failure the user
// sees: `--stop` reports success for an instance it never touched, and a plain
// `mdr` attaches to it.
//
// Driven through the `__find-server` seam rather than `--stop`, because --stop
// kills what it finds and also sweeps 5188-5197 for a Vite client, which on a
// developer's machine is their own dev server.

const BIN = join(__dirname, 'md-redline');

const servers: Server[] = [];
const children: ChildProcess[] = [];
let scratch: string | null = null;

/**
 * A server that answers the way mdr does. `checkServer` requires `/api/config`
 * to return an object with a `homeDir` string, so anything less is not
 * something the CLI would ever select.
 */
function startFakeServer(): Promise<{ port: number }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ homeDir: '/tmp/fake-home' }));
        return;
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
      resolvePromise({ port: address.port });
    });
  });
}

/** The scratch temp dir for this test, created on first use. */
function scratchDir(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'mdr-find-'));
  return scratch;
}

/** Run the seam with the port file redirected into a scratch temp dir. */
function findServer(env: NodeJS.ProcessEnv = {}): Promise<string> {
  const dir = scratchDir();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, '__find-server'], {
      env: {
        ...process.env,
        // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows, and it is
        // what decides where the port file lives. Redirected so the test never
        // reads or writes the one a real mdr on this machine is using.
        TMPDIR: dir,
        TEMP: dir,
        TMP: dir,
        MD_REDLINE_PORT: '',
        PORT: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.once('error', reject);
    // 'close', not 'exit': exit can fire before stdio has drained, and the
    // port this reads IS the assertion. Every other subprocess test in bin/
    // uses 'exit', but none of them races the child's last write.
    child.once('close', () => resolvePromise(stdout.trim()));
  });
}

function writePortFile(port: number): void {
  writeFileSync(join(scratchDir(), 'md-redline.port'), String(port));
}

afterEach(async () => {
  // A child that never exits would otherwise outlive the test that spawned it:
  // vitest abandons the awaiting promise on timeout, but nothing reaps the
  // process. The servers get the same treatment, which they already had.
  for (const child of children.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('choosing which running server to act on', () => {
  it('picks the port the user named over the one in the port file', async () => {
    // The report: two servers up, the port file naming whichever started last.
    // `MD_REDLINE_PORT=7441 mdr --stop` printed "mdr stopped." while 7441 kept
    // running and 7440, which the user never named, was the one that died.
    const named = await startFakeServer();
    const recorded = await startFakeServer();
    writePortFile(recorded.port);

    expect(await findServer({ MD_REDLINE_PORT: String(named.port) })).toBe(String(named.port));
  });

  it('accepts the PORT alias as naming a server too', async () => {
    const named = await startFakeServer();
    const recorded = await startFakeServer();
    writePortFile(recorded.port);

    expect(await findServer({ PORT: String(named.port) })).toBe(String(named.port));
  });

  it('falls back to the port file when the named server is not answering', async () => {
    // Naming a port is not a demand that it be the only candidate. A stale
    // MD_REDLINE_PORT in a shell profile must not stop the CLI finding the
    // server that is actually running.
    const recorded = await startFakeServer();
    writePortFile(recorded.port);
    const deadPort = await unusedPort();

    expect(await findServer({ MD_REDLINE_PORT: String(deadPort) })).toBe(String(recorded.port));
  });

  it('still prefers the port file when nothing was named', async () => {
    // How a server that scanned upward past a busy default gets found at all.
    const recorded = await startFakeServer();
    writePortFile(recorded.port);

    expect(await findServer()).toBe(String(recorded.port));
  });

  it('reports none when the named port is dead and nothing is recorded', async () => {
    const deadPort = await unusedPort();

    expect(await findServer({ MD_REDLINE_PORT: String(deadPort) })).toBe('none');
  });
});

/**
 * A port nothing is listening on: bound, read back, released.
 *
 * Deliberately not startFakeServer plus a pop() off the shared array. That
 * borrowed both its request handling, which is irrelevant here, and an
 * assumption that every caller awaits sequentially, which would silently close
 * somebody else's server the first time two of these ran concurrently.
 */
async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      resolvePromise(address.port);
    });
  });
  await new Promise((r) => server.close(r));
  return port;
}
