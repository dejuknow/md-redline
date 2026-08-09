import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import { createBrowserStub } from './cli-browser-stub.js';

// Regression test for the browser launcher. The CLI's internal `__open <url>`
// seam runs openInBrowser() and exits immediately — the exact shape of the bug
// where, on Windows, `cmd /c start` was torn down before it could launch the
// browser because the CLI unref'd and exited within milliseconds.
// MD_REDLINE_BROWSER points the launcher at a stub that records that it ran; if the launcher does
// not survive the CLI exiting (the pre-fix behavior) the marker never appears
// and this fails. Deterministic and headless on every OS, so it guards the
// spawn path in CI without needing a real browser or a desktop session.

const BIN = join(__dirname, 'md-redline');

// Both browser variables blanked, then whatever the test sets on top. Spreading
// process.env raw means a contributor who exports MD_REDLINE_BROWSER (the
// README's own example) either fails these tests or, worse, has npm test spawn
// their real browser. Empty string rather than delete, because the launcher takes
// the first NON-EMPTY value, so blank reads as unset while ALSO keeping the
// legacy-name test honest: under the old `??` resolution an empty new name
// discarded a working legacy one, and blanking is what makes that go red.
//
// The cost is that both keys are always DEFINED here, so no test using cleanEnv()
// alone exercises a genuinely unset variable. The last test in this file deletes
// them for exactly that reason; do not fold it back into cleanEnv().
function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, MD_REDLINE_BROWSER: '', MDR_BROWSER: '', ...overrides };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code));
  });
}

// Waits for content, not for the file. The Windows stub writes its marker as
// `>"marker" <nul set /p "=%~1"`, and the redirect creates the file before
// set /p puts anything in it. Polling on existence alone returns inside that
// window, and the caller's readFileSync then reads "" and fails a test that
// has nothing wrong with it. Every marker these tests wait on carries a URL,
// so non-empty is the honest signal that the stub actually ran.
function hasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

async function waitForMarker(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasContent(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return hasContent(path);
}

// Shadows the platform's own opener on PATH so the no-override default path can
// be driven without launching a real browser. Windows is deliberately not
// supported: its default path is `cmd /c start` through ComSpec, which never
// consults PATH, so that one branch stays verifiable only by hand on a real
// desktop session.
function createPathShadowStub(dir: string, markerPath: string): void {
  const stub = join(dir, process.platform === 'darwin' ? 'open' : 'xdg-open');
  writeFileSync(stub, `#!/bin/sh\nprintf %s "$1" > "${markerPath}"\n`);
  chmodSync(stub, 0o755);
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

    const url = 'http://127.0.0.1:65535/probe?file=C%3A%5CUsers%5Cme%5Cspec.md';
    const code = await runCli(['__open', url], cleanEnv({ MD_REDLINE_BROWSER: stub }));
    expect(code).toBe(0);

    // The launcher is detached, so it writes the marker shortly AFTER the CLI
    // has exited — poll for it. Pre-fix (non-detached on Windows) it never
    // appears because the child was torn down with the parent.
    const launched = await waitForMarker(marker, 5000);
    expect(launched, 'browser stub never ran: the launcher did not survive CLI exit').toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(url);
  }, 15_000);

  // MDR_BROWSER is the original name. It shipped and is documented, so it stays
  // supported even though every other variable uses the MD_REDLINE_ prefix.
  it('still honours the legacy MDR_BROWSER name', async () => {
    const dir = freshTempDir();
    const marker = join(dir, 'launched.txt');
    const stub = createBrowserStub(dir, marker);

    const url = 'http://127.0.0.1:65535/legacy';
    const code = await runCli(['__open', url], cleanEnv({ MDR_BROWSER: stub }));
    expect(code).toBe(0);
    expect(await waitForMarker(marker, 5000)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(url);
  }, 15_000);

  // An empty or whitespace-only new name must not mask a working old one: `??`
  // alone falls through on undefined and hands the empty string to the launcher.
  it.each(['', '   '])(
    'an empty MD_REDLINE_BROWSER (%j) falls back to MDR_BROWSER',
    async (blank) => {
      const dir = freshTempDir();
      const marker = join(dir, 'launched.txt');
      const stub = createBrowserStub(dir, marker);

      const url = 'http://127.0.0.1:65535/blank';
      const code = await runCli(
        ['__open', url],
        cleanEnv({ MD_REDLINE_BROWSER: blank, MDR_BROWSER: stub }),
      );
      expect(code).toBe(0);
      expect(await waitForMarker(marker, 5000)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe(url);
    },
    15_000,
  );

  // If both are set the new name wins, so a stale MDR_BROWSER in a shell profile
  // cannot quietly override a deliberate MD_REDLINE_BROWSER.
  it('prefers MD_REDLINE_BROWSER when both are set', async () => {
    // Separate dirs: createBrowserStub writes a fixed filename, so two stubs in
    // one dir would overwrite each other and both vars would point at the same
    // script.
    const wantedDir = freshTempDir();
    const legacyDir = freshTempDir();
    const wanted = join(wantedDir, 'wanted.txt');
    const legacy = join(legacyDir, 'legacy.txt');
    const wantedStub = createBrowserStub(wantedDir, wanted);
    const legacyStub = createBrowserStub(legacyDir, legacy);

    const url = 'http://127.0.0.1:65535/both';
    const code = await runCli(
      ['__open', url],
      cleanEnv({ MD_REDLINE_BROWSER: wantedStub, MDR_BROWSER: legacyStub }),
    );
    expect(code).toBe(0);
    expect(await waitForMarker(wanted, 5000)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  }, 15_000);

  // Neither variable set is the ordinary case, and it was the one case nothing
  // covered. cleanEnv() defines both keys as empty strings, so a launcher that
  // lost its optional chain (`v.trim()` for `v?.trim()`) threw a TypeError for
  // every user who has set no browser at all while this suite stayed fully green.
  // Deleting the keys instead of blanking them is the entire point here, and it
  // covers the platform default branch as a bonus.
  it.skipIf(process.platform === 'win32')(
    'falls through to the platform opener when neither variable is set',
    async () => {
      const dir = freshTempDir();
      const marker = join(dir, 'opened.txt');
      createPathShadowStub(dir, marker);

      const env = cleanEnv();
      delete env.MD_REDLINE_BROWSER;
      delete env.MDR_BROWSER;
      env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;

      const url = 'http://127.0.0.1:65535/default-path';
      const code = await runCli(['__open', url], env);
      expect(code).toBe(0);
      expect(await waitForMarker(marker, 5000)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe(url);
    },
    15_000,
  );
});

// The CLI is the third reader of the API port, and the one no unit test can reach:
// the value seeds the fallback scan inside findServerPort, so it is invisible from
// outside unless the CLI is asked. Without this, re-inlining an expression here
// leaves the whole suite green while a documented `PORT=7100` sends the CLI
// scanning from 6373 and the server binds 7100. The expected values come from
// server/env.test.ts's table, which is the same function.
describe('mdr resolves the API port the same way the server does', () => {
  function runCliCapturingStdout(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.once('error', reject);
      child.once('exit', () => resolvePromise(out.trim()));
    });
  }

  it.each([
    ['the prefixed name', { MD_REDLINE_PORT: '7100' }, '7100'],
    ['the documented bare alias', { PORT: '7100' }, '7100'],
    ['the prefixed name winning over the alias', { MD_REDLINE_PORT: '7100', PORT: '7200' }, '7100'],
    ['a blank prefixed name deferring to the alias', { MD_REDLINE_PORT: '', PORT: '7100' }, '7100'],
    ['a malformed value, not truncated to 7100', { MD_REDLINE_PORT: '7100nonsense' }, '6373'],
    ['neither set', {}, '6373'],
  ])(
    'honours %s',
    async (_label, overrides, expected) => {
      const env = cleanEnv({ MD_REDLINE_PORT: '', PORT: '', ...overrides });
      expect(await runCliCapturingStdout(['__port'], env)).toBe(expected);
    },
    15_000,
  );
});
