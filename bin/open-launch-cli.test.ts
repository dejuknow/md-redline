import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createBrowserStub } from './cli-browser-stub.js';

// Regression test for the browser launcher. The CLI's internal `__open <url>`
// seam runs openInBrowser() and exits immediately — the exact shape of the bug
// where, on Windows, `cmd /c start` was torn down before it could launch the
// browser because the CLI unref'd and exited within milliseconds. MDR_BROWSER
// points the launcher at a stub that records that it ran; if the launcher does
// not survive the CLI exiting (the pre-fix behavior) the marker never appears
// and this fails. Deterministic and headless on every OS, so it guards the
// spawn path in CI without needing a real browser or a desktop session.

const BIN = join(__dirname, 'md-redline');

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code));
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(path);
}

describe('mdr browser launcher (subprocess)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mdr-open-launch-'));
    tempDirs.push(dir);
    return dir;
  }

  it('launches the browser and it survives the CLI exiting immediately', async () => {
    const dir = freshTempDir();
    const marker = join(dir, 'launched.txt');
    const stub = createBrowserStub(dir, marker);

    const code = await runCli(['__open', 'http://127.0.0.1:65535/probe?file=C%3A%5Cspec.md'], {
      ...process.env,
      MDR_BROWSER: stub,
    });
    expect(code).toBe(0);

    // The launcher is detached, so it writes the marker shortly AFTER the CLI
    // has exited — poll for it. Pre-fix (non-detached on Windows) it never
    // appears because the child was torn down with the parent.
    const launched = await waitForFile(marker, 5000);
    expect(launched, 'browser stub never ran: the launcher did not survive CLI exit').toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('LAUNCHED');
  }, 15_000);
});
