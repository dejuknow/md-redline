import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// These cover the two files the CLI writes that something else also owns: the
// user's `.md-redline.json`, which the server rewrites on every boot, and
// Claude Desktop's MCP config, which holds every other MCP server the user has
// configured. Both used to go out through a bare writeFile.
//
// Driven as a subprocess with HOME/USERPROFILE pointed at a scratch dir,
// because os.homedir() is what picks the paths and there is no seam for it.

const BIN = join(__dirname, 'md-redline');
const PREFS = '.md-redline.json';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // getClaudeDesktopConfigPath reads APPDATA before falling back to the
        // home dir, so a real one on Windows would send the write outside the
        // scratch dir and into the developer's own Claude config.
        APPDATA: join(home, 'AppData', 'Roaming'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Claude Desktop's config path for a given fake home, per platform. */
function desktopConfigPath(home: string): string {
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// chmod only toggles a read-only bit on Windows, and root ignores the mode
// bits entirely, so the deny-read cases cannot be staged in either. They guard
// POSIX behavior; the Windows-specific write hazards are covered by the
// fault-injection suites in server/.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'md-redline-cli-home-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    // chmod back first, or a directory a test locked cannot be removed.
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

describe('mdr --restrict', () => {
  it('writes the prefs file and leaves no temp or lock behind', async () => {
    const home = makeHome();

    const result = await runCli(['--restrict'], home);

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, PREFS), 'utf8'))).toEqual({ trustedRoots: [] });
    // A leaked lock blocks every later write, from this process and the
    // server both, until it ages out 30s later.
    expect(readdirSync(home).filter((e) => e.endsWith('.lock') || e.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to overwrite an existing prefs file', async () => {
    const home = makeHome();
    const saved = JSON.stringify({ trustedRoots: ['/vault'], author: 'Dennis' });
    writeFileSync(join(home, PREFS), saved);

    const result = await runCli(['--restrict'], home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing to overwrite');
    expect(readFileSync(join(home, PREFS), 'utf8')).toBe(saved);
    expect(readdirSync(home).filter((e) => e.endsWith('.lock') || e.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(!canDenyRead)(
    'refuses rather than guessing when the prefs file cannot be stat-ed',
    async () => {
      // An unreadable home is the case that used to fall into the "safe to
      // write" branch and clobber trust settings the CLI could not see.
      const home = makeHome();
      writeFileSync(join(home, PREFS), JSON.stringify({ trustedRoots: ['/vault'] }));
      chmodSync(home, 0o000);

      const result = await runCli(['--restrict'], home);

      chmodSync(home, 0o700);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Refusing to write over a file');
      expect(JSON.parse(readFileSync(join(home, PREFS), 'utf8'))).toEqual({
        trustedRoots: ['/vault'],
      });
    },
  );

  it('gives up instead of racing a lock another process is holding', async () => {
    const home = makeHome();
    // A fresh lock file, as a mid-write server would leave: young enough that
    // the stale-steal path does not fire.
    writeFileSync(join(home, `${PREFS}.lock`), '99999');

    const result = await runCli(['--restrict'], home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Another mdr process is writing it');
    // The whole point: it did NOT write while another writer held the lock.
    expect(existsSync(join(home, PREFS))).toBe(false);
  }, 15_000);
});

describe('mdr __first-launch', () => {
  it('is a first launch when no prefs file exists', async () => {
    const home = makeHome();

    expect((await runCli(['__first-launch'], home)).stdout.trim()).toBe('true');
  });

  it('is not a first launch once trustedRoots has been recorded', async () => {
    const home = makeHome();
    writeFileSync(join(home, PREFS), JSON.stringify({ trustedRoots: ['/vault'] }));

    expect((await runCli(['__first-launch'], home)).stdout.trim()).toBe('false');
  });

  it.skipIf(!canDenyRead)(
    'is not a first launch when the prefs file exists but cannot be read',
    async () => {
      // Returning true here greets a user who has run mdr for months with the
      // trust disclosure, on every single launch.
      const home = makeHome();
      writeFileSync(join(home, PREFS), JSON.stringify({ trustedRoots: ['/vault'] }));
      chmodSync(join(home, PREFS), 0o000);

      const result = await runCli(['__first-launch'], home);

      chmodSync(join(home, PREFS), 0o600);
      expect(result.stdout.trim()).toBe('false');
    },
  );

  it('is a first launch when the prefs file is unparseable', async () => {
    // The server quarantines it on boot and starts fresh with default trust,
    // so the disclosure is accurate.
    const home = makeHome();
    writeFileSync(join(home, PREFS), '{ not json');

    expect((await runCli(['__first-launch'], home)).stdout.trim()).toBe('true');
  });
});

describe('mdr mcp install --claude-desktop', () => {
  it('keeps every other MCP server in the config', async () => {
    const home = makeHome();
    const configPath = desktopConfigPath(home);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'fs'] } } }),
    );

    const result = await runCli(['mcp', 'install', '--claude-desktop'], home);

    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', 'fs'] });
    expect(written.mcpServers['md-redline']).toEqual({ command: 'mdr', args: ['mcp'] });
    expect(readdirSync(dirname(configPath)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(!canDenyRead)(
    'aborts without writing when the existing config cannot be read',
    async () => {
      // Starting fresh over a config we could not read deletes every other MCP
      // server the user has, which is the worst outcome available here.
      const home = makeHome();
      const configPath = desktopConfigPath(home);
      mkdirSync(dirname(configPath), { recursive: true });
      const saved = JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } });
      writeFileSync(configPath, saved);
      chmodSync(configPath, 0o000);

      const result = await runCli(['mcp', 'install', '--claude-desktop'], home);

      chmodSync(configPath, 0o600);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Cannot read');
      expect(readFileSync(configPath, 'utf8')).toBe(saved);
    },
  );
});
