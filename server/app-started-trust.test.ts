/**
 * A server the desktop app starts runs from the user's home folder, and a
 * server trusts the folder it starts in. In restricted mode (`mdr --restrict`)
 * that quietly widened trust to the whole home folder (#239). The app now sets
 * MD_REDLINE_INTERNAL_NO_CWD_TRUST=1 when it runs `mdr --no-open`, and the CLI
 * hands its environment to the server it spawns.
 *
 * These tests boot the real server on source, the way the app's start does
 * (home folder as the working directory, the app's env var), against a scratch
 * home with restricted prefs, and check what it trusts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer as createNetServer } from 'net';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const SERVER_ENTRY = join(__dirname, 'index.ts');
// Resolved from the repo, because the server runs from the scratch home where
// a bare `--import tsx` would not find the package.
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;

const liveChildren: ChildProcess[] = [];
const scratchDirs: string[] = [];

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** A free port in 28000-29000, clear of a developer's own mdr on 6373 and of
 * session-restart.test.ts's 27000-28000 block. */
async function pickTestPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 28_000 + Math.floor(Math.random() * 1_000);
    if (await portIsFree(port)) return port;
  }
  throw new Error('no free port found in the 28000-29000 test range');
}

function scratch(prefix: string): string {
  // The real long path: on Windows runners tmpdir() is an 8.3 short form
  // (RUNNER~1), which the server's async realpath expands and plain
  // realpathSync does not, so roots written in the short form never match.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

interface Launched {
  baseUrl: string;
  output(): string;
}

/** Start the server from `home`, with `home` as MD_REDLINE_HOME, as the app's
 * `mdr --no-open` does. A scratch TMPDIR keeps the server's port file away
 * from the shared one a developer's own mdr reads. */
async function launchFromHome(home: string, extraEnv: NodeJS.ProcessEnv): Promise<Launched> {
  const port = await pickTestPort();
  const tmpDir = scratch('mdr-app-trust-tmp-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MD_REDLINE_HOME: home,
    MD_REDLINE_PORT: String(port),
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    NODE_ENV: 'test',
    NO_UPDATE_NOTIFIER: '1',
    MD_REDLINE_PERSIST_SESSIONS: '0',
    ...extraEnv,
  };
  if (!('MD_REDLINE_INTERNAL_NO_CWD_TRUST' in extraEnv)) {
    delete env.MD_REDLINE_INTERNAL_NO_CWD_TRUST;
  }
  const child = spawn(process.execPath, ['--import', TSX_LOADER, SERVER_ENTRY], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  liveChildren.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/review-sessions`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`server never became ready; output:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { baseUrl, output: () => output };
}

/** A scratch home with restricted prefs that trust one project folder. */
function restrictedHome(): { home: string; homeNote: string; projectNote: string } {
  const home = scratch('mdr-app-trust-home-');
  const project = join(home, 'project');
  mkdirSync(project);
  const homeNote = join(home, 'home-note.md');
  const projectNote = join(project, 'project-note.md');
  writeFileSync(homeNote, '# Home note\n');
  writeFileSync(projectNote, '# Project note\n');
  writeFileSync(join(home, '.md-redline.json'), JSON.stringify({ trustedRoots: [project] }));
  return { home, homeNote, projectNote };
}

afterEach(async () => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('a server started the way the desktop app starts it', () => {
  it('does not trust the home folder it runs from in restricted mode', async () => {
    const { home, homeNote, projectNote } = restrictedHome();
    const server = await launchFromHome(home, { MD_REDLINE_INTERNAL_NO_CWD_TRUST: '1' });

    const homeRes = await fetch(`${server.baseUrl}/api/file?path=${encodeURIComponent(homeNote)}`);
    expect(homeRes.status, server.output()).toBe(403);

    // The persisted roots still load.
    const projectRes = await fetch(
      `${server.baseUrl}/api/file?path=${encodeURIComponent(projectNote)}`,
    );
    expect(projectRes.status, server.output()).toBe(200);
  }, 30_000);

  it('names the refused start folder when the explorer browses without a folder', async () => {
    const { home } = restrictedHome();
    const server = await launchFromHome(home, { MD_REDLINE_INTERNAL_NO_CWD_TRUST: '1' });

    const res = await fetch(`${server.baseUrl}/api/browse`);
    expect(res.status, server.output()).toBe(403);
    const body = (await res.json()) as { error?: string; dir?: string };
    expect(body.error).toMatch(/^Access denied/);
    expect(body.dir).toBe(home);
  }, 30_000);

  it('still trusts its start folder when started without the app flag', async () => {
    const { home, homeNote } = restrictedHome();
    const server = await launchFromHome(home, {});

    const res = await fetch(`${server.baseUrl}/api/file?path=${encodeURIComponent(homeNote)}`);
    expect(res.status, server.output()).toBe(200);
  }, 30_000);
});
