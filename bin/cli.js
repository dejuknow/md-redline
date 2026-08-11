/**
 * The `mdr` command: everything it does, on import.
 *
 * The published entry point is `bin/md-redline`, which exists only to import
 * this file. That name is what `package.json` maps both commands to, and it
 * cannot carry an extension; without one, `tsconfig.bin.json` could not include
 * the largest file in the package and nothing type-checked it. Splitting the
 * name from the body was the cheapest way to have both.
 *
 * Plain JS with JSDoc types, shipped as is, for the same reason the modules it
 * imports are: there is no build step between a publish and the user running
 * this. `npm run build` never touches it.
 */

import { spawn } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { mkdir, readFile, stat, unlink } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import process from 'process';
import { fileURLToPath, pathToFileURL } from 'url';

import { createRequire } from 'module';
import { acquireFileLock, LOCK_MAX_WAIT_MS, LockContentionError } from './file-lock.js';
import { atomicWriteFile, retryTransient } from './fs-atomic.js';
import { resolveHomeDir } from './home-dir.js';
import { resolveApiPort } from './ports.js';

import { checkServer, gracefulShutdown, killPort } from './server-control.js';
import { buildWindowsCommand } from './spawn-command.js';
import { isNewerVersion } from './version-compare.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_DIR = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require(join(APP_DIR, 'package.json'));
const DIST_SERVER = join(APP_DIR, 'dist', 'server.js');
const DEFAULT_SERVER_PORT = resolveApiPort();
// Pre-0.7 servers bound 3001+. 0.7.0 (2026-07-18) moved the default to 6373, and
// 0.6.0 shipped four days before it, so a machine that has not rebooted since can
// still have one running. Scanning the old range lets the stale-server upgrade path
// find that server and stop it, and keeps `mdr --stop` working across the
// migration. Drop this at 0.8.0 or after 2026-11-01, whichever is later: these are
// local servers, so one reboot cycle clears every one of them.
const LEGACY_SERVER_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5188;
const MAX_PORT_SCAN = 10;
const PORT_FILE = join(tmpdir(), 'md-redline.port');
const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const UPDATE_CHECK_WAIT_MS = 6_000;
const UPDATE_CHECK_POLL_MS = 100;

function printHelp() {
  console.log('Usage: mdr [file.md | directory]');
  console.log('       mdr --stop');
  console.log('       mdr --restrict');
  console.log('');
  console.log('Opens a markdown file or folder in mdr for inline commenting.');
  console.log('Starts the app automatically if it is not already running.');
  console.log('Supported platforms: macOS, Linux, and Windows.');
  console.log('');
  console.log('Options:');
  console.log('  --stop          Stop the running mdr server');
  console.log('  --restrict      Disable the default home-directory trust');
  console.log('  -v, --version   Show version number');
  console.log('  -h, --help      Show this help message');
  console.log('');
  console.log('Subcommands:');
  console.log('  mcp             Run the MCP server (called by the MCP client)');
  console.log('  mcp install     Register md-redline with Claude Code and Claude Desktop');
  console.log('                    --claude-code     just Claude Code (via `claude mcp add`)');
  console.log('                    --claude-desktop  just Claude Desktop (JSON config file)');
  console.log('');
  console.log('Alias: md-redline');
}

/**
 * What the server will do about trust on this launch, which is what decides
 * whether to disclose it and in what words.
 *
 * 'seeded'     no trustedRoots on record, so the server seeds the home
 *              directory. The genuine first launch, and the case a corrupt
 *              file lands in too, since the server quarantines it and starts
 *              fresh.
 * 'unreadable' a prefs file exists and could not be read. The server ALSO
 *              seeds home here (createApp's first-launch branch fires on
 *              `trustedRoots === undefined`, and it applies in memory even
 *              though it refuses to persist), so a user who ran `--restrict`
 *              silently gets home trust back for this session. That has to be
 *              said, and it is not a welcome.
 * 'configured' trustedRoots is on record. Nothing to disclose.
 */
async function trustDisclosureState() {
  const prefsPath = join(resolveHomeDir(), '.md-redline.json');
  let raw;
  try {
    raw = await retryTransient(() => readFile(prefsPath, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? 'seeded' : 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'seeded';
    return parsed.trustedRoots === undefined ? 'seeded' : 'configured';
  } catch {
    return 'seeded';
  }
}

function expandHomePath(inputPath) {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return resolve(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

async function resolveTarget(arg) {
  if (!arg) return { file: '', dir: '' };

  const target = resolve(expandHomePath(arg));
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch {
    // Echo the resolved path too: `mdr ~/Desktop` on a OneDrive-redirected
    // Windows profile fails because C:\Users\<u>\Desktop does not exist,
    // which the raw argument alone cannot reveal.
    throw new Error(
      target === arg ? `not found: ${arg}` : `not found: ${arg} (resolved to ${target})`,
    );
  }

  if (targetStat.isDirectory()) return { file: '', dir: target };
  if (targetStat.isFile()) return { file: target, dir: '' };
  throw new Error(`not a file or directory: ${arg}`);
}

async function findServerPort() {
  // Try the port file first (fast path)
  try {
    const saved = (await readFile(PORT_FILE, 'utf8')).trim();
    const port = Number(saved);
    if (port && (await checkServer(port))) return port;
  } catch {
    // No port file, an unreadable one, or a port nothing answers on. All three
    // mean the same thing here: nothing recorded, so scan for it.
  }

  // Scan the port range as fallback, then the legacy pre-0.7 range
  const bases =
    DEFAULT_SERVER_PORT === LEGACY_SERVER_PORT
      ? [DEFAULT_SERVER_PORT]
      : [DEFAULT_SERVER_PORT, LEGACY_SERVER_PORT];
  for (const base of bases) {
    for (let p = base; p < base + MAX_PORT_SCAN; p++) {
      if (await checkServer(p)) return p;
    }
  }
  return null;
}

async function findClientPort() {
  for (let p = DEFAULT_CLIENT_PORT; p < DEFAULT_CLIENT_PORT + MAX_PORT_SCAN; p++) {
    try {
      const response = await fetch(`http://127.0.0.1:${p}/__mdr__`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await response.text()) === 'mdr') return p;
    } catch {
      // Nothing listening, something that is not us, or a timeout. This is a
      // scan: every failure just means try the next port.
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const isWin = process.platform === 'win32';
    const spawnCwd = options.cwd ?? APP_DIR;
    const child = isWin
      ? spawn(buildWindowsCommand(command, args), {
          cwd: spawnCwd,
          // Opt-in only. On Windows `detached` gives the child its own console
          // window that windowsHide can't reliably suppress under shell:true,
          // so a long-lived child (the server) would leave a visible console.
          // The browser launcher needs it: without detached, `cmd /c start` is
          // torn down before ShellExecute fires because the CLI unrefs and
          // exits within milliseconds. Its cmd exits instantly, so no window
          // ever shows.
          detached: options.detached === true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd: spawnCwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });

    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn(child);
    });
  });
}

// Named once each, then referenced through these constants everywhere below.
// Each name appears in two unrelated syntaxes: an env key Node sets, and a %VAR%
// placeholder inside a string cmd.exe expands. A rename that updates one syntax
// but not the other spawns `start "" ""`, which silently opens Explorer instead
// of the browser. Sourcing both spellings from one identifier makes that
// mismatch unreachable, which matters because no test can catch it: a faithful
// ComSpec stub is impossible (Node refuses to spawn .cmd/.bat without a shell,
// and only real cmd.exe expands %VAR%), so the only check is a human on Windows.
const BROWSER_COMMAND_VAR = 'MD_REDLINE_INTERNAL_BROWSER_COMMAND';
const BROWSER_URL_VAR = 'MD_REDLINE_INTERNAL_BROWSER_URL';

function spawnWindowsBrowser(command, url, { shellCommand = false } = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const env = {
      ...process.env,
      [BROWSER_COMMAND_VAR]: command,
      [BROWSER_URL_VAR]: url,
    };
    const child = shellCommand
      ? spawn(
          process.env.ComSpec ?? 'cmd.exe',
          [
            '/d',
            '/s',
            '/c',
            // Outer quote pair is required: with /s, cmd strips only the first and
            // last quote of the /c string, leaving `"cmd" "url"` intact. Pair it
            // with windowsVerbatimArguments so Node does not backslash-escape the
            // inner quotes (\") — cmd reads those literally and the command name
            // becomes unrecognized.
            `""%${BROWSER_COMMAND_VAR}%" "%${BROWSER_URL_VAR}%""`,
          ],
          {
            cwd: APP_DIR,
            detached: true,
            stdio: 'ignore',
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        )
      : spawn(command, [url], {
          cwd: APP_DIR,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });

    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn(child);
    });
  });
}

function openWithWindowsShell(url) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    // Keep the encoded URL out of cmd.exe's command string. cmd expands the
    // placeholder once and does not recursively expand percent signs in its
    // value, so URL escapes such as %3A and %5C reach the browser intact.
    // The outer quote pair plus windowsVerbatimArguments keeps cmd's /s quote
    // stripping and Node's argv escaping from mangling `start "" "url"` (without
    // them Node emits \" and the browser receives a corrupted \"url\").
    const child = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `"start "" "%${BROWSER_URL_VAR}%""`],
      {
        cwd: APP_DIR,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [BROWSER_URL_VAR]: url },
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    );

    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn(child);
    });
  });
}

async function stopServer(quiet = false) {
  const serverPort = await findServerPort();
  if (!serverPort) {
    if (!quiet) console.log('mdr is not running.');
    return;
  }

  if (!quiet) console.log('Stopping mdr...');
  killPort(serverPort);

  // Also kill the Vite client if running (only kill ports that respond)
  const clientPort = await findClientPort();
  if (clientPort) {
    killPort(clientPort);
  }

  // Clean up port file
  try {
    await unlink(PORT_FILE);
  } catch {
    // Already gone is the ordinary case: the server removes it on the way out.
  }

  if (!quiet) console.log('mdr stopped.');
}

async function enableRestrictedMode() {
  // resolveHomeDir, not homedir(): with MD_REDLINE_HOME set, a bare homedir()
  // writes and locks a file the server never reads, so this would report
  // success while trust stayed exactly as it was.
  const prefsPath = join(resolveHomeDir(), '.md-redline.json');

  // The server takes this same lock around its own read-modify-write of the
  // prefs file. Without it, `mdr --restrict` racing a booting server either
  // clobbers the trust settings it promises not to touch, or has its own write
  // swallowed by the server's rename and silently fails to restrict anything.
  let release;
  try {
    release = await acquireFileLock(prefsPath);
  } catch (err) {
    // Contention and a filesystem failure need different advice, and telling
    // someone with an unwritable home directory to wait for another process is
    // a dead end. Discriminating on `err.code` alone got this backwards: on
    // Windows an EACCES on the lock file IS retried, so a permanent condition
    // arrives here as an exhausted budget with no errno of its own.
    if (err instanceof LockContentionError) {
      console.error(`Could not lock ${prefsPath} after ${LOCK_MAX_WAIT_MS}ms.`);
      // `cause` is declared unknown, because Error.cause is. Everything the
      // lock puts there is a filesystem error, and reading `.code` off it is
      // the entire point of carrying it.
      const cause = /** @type {NodeJS.ErrnoException | undefined} */ (err.cause);
      if (cause?.code) {
        console.error(`Last error: ${cause.code}. Check permissions on ${dirname(prefsPath)}.`);
      } else {
        console.error('Another mdr process is writing it. Try again in a moment.');
      }
    } else {
      console.error(`Could not lock ${prefsPath} (${err.code}): ${err.message}`);
      console.error('Refusing to write over a file that may hold your trust settings.');
    }
    process.exitCode = 1;
    return;
  }

  try {
    // Checked under the lock, and only ENOENT counts as absent. A stat that
    // bounces off a scanner cannot prove the file is missing, and guessing
    // wrong here overwrites the trust settings this branch exists to protect.
    try {
      await retryTransient(() => stat(prefsPath));
      console.error(`Refusing to overwrite existing ${prefsPath}.`);
      console.error('Restricted mode would clobber your trust settings.');
      console.error('Edit the file manually to set trustedRoots: [].');
      process.exitCode = 1;
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Could not check ${prefsPath} (${err.code}).`);
        console.error('Refusing to write over a file that may hold your trust settings.');
        process.exitCode = 1;
        return;
      }
    }

    try {
      await atomicWriteFile(prefsPath, JSON.stringify({ trustedRoots: [] }, null, 2) + '\n');
    } catch (err) {
      // Every other branch here exits 1 with an explanation. Letting this one
      // escape to main() printed a raw stack instead, with nothing to say
      // whether restricted mode had been applied.
      console.error(`Could not write ${prefsPath} (${err.code ?? 'unknown'}): ${err.message}`);
      console.error('Restricted mode was NOT enabled.');
      process.exitCode = 1;
      return;
    }
  } finally {
    await release();
  }

  console.log('Restricted mode enabled. Each folder will require explicit consent.');
  console.log(`Wrote ${prefsPath}`);
}

async function getServerVersionInfo(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      // Parsed JSON off the wire is unknown by construction, and the checks
      // below are what turn it into the shape this returns. Naming that shape
      // as optional-unknown keeps those checks load-bearing rather than
      // decorative: drop one and the compiler asks for it back.
      const data = /** @type {Record<string, unknown> | null} */ (await response.json());
      if (data && typeof data.version === 'string') {
        return {
          version: data.version,
          latest: typeof data.latest === 'string' ? data.latest : null,
          updateCheckPending: data.updateCheckPending === true,
        };
      }
    }
  } catch {
    // Unreachable, too slow, or answering with something other than a version.
    // The caller reads null as "could not ask" and carries on either way.
  }
  return null;
}

async function waitForUpdateCheck(port, initialInfo) {
  let info = initialInfo;
  const deadline = Date.now() + UPDATE_CHECK_WAIT_MS;
  while (info?.updateCheckPending && Date.now() < deadline) {
    await delay(UPDATE_CHECK_POLL_MS);
    info = (await getServerVersionInfo(port)) ?? info;
  }
  return info;
}

function isProductionMode() {
  try {
    statSync(DIST_SERVER);
    return true;
  } catch {
    return false;
  }
}

async function ensureServerRunning() {
  const existing = await findServerPort();
  if (existing) {
    const info = await getServerVersionInfo(existing);
    if (info && info.version !== CLI_VERSION) {
      console.log(`Upgrading mdr ${info.version} → ${CLI_VERSION}...`);
      const stopped = await gracefulShutdown(existing);
      if (!stopped) await stopServer(true);
    } else {
      return info;
    }
  }

  // Detect first ever launch (no prefs file yet) so we can disclose the
  // default trust behavior. The server itself will write the prefs file on
  // boot; we check BEFORE spawning so the message corresponds to the very
  // first invocation only.
  const disclosure = await trustDisclosureState();
  if (disclosure === 'seeded') {
    console.log('Welcome to md-redline! Trusting your home directory by default.');
    console.log(
      'Run `mdr --restrict` to opt out. See https://github.com/dejuknow/md-redline#permissions for details.',
    );
  } else if (disclosure === 'unreadable') {
    // Not a welcome. This user has run mdr before and may well have opted out
    // of home trust, and the point is that their opt-out is not in effect.
    console.log(`Could not read ${join(resolveHomeDir(), '.md-redline.json')}.`);
    console.log('Trusting your home directory for this session until it can be read again.');
  }

  if (!existing) console.log('Starting mdr...');
  let childExited = false;
  let child;
  if (isProductionMode()) {
    const serverArgs = [DIST_SERVER];
    const userArg = process.argv[2];
    // Don't forward the `mcp` subcommand as a positional file arg. When
    // Claude Code spawns `mdr mcp`, argv[2] is 'mcp', which would otherwise
    // resolve against Claude Code's cwd and get passed to the server as an
    // initial path — triggering a bogus trusted-roots permission dialog.
    if (userArg && !userArg.startsWith('-') && userArg !== 'mcp') {
      serverArgs.push(resolve(userArg));
    }
    child = await spawnDetached(process.execPath, serverArgs, { cwd: process.cwd() });
  } else {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    child = await spawnDetached(npmCommand, ['run', 'dev']);
  }
  child.once('exit', () => {
    childExited = true;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  // Wait for the API server
  while (Date.now() < deadline) {
    if (await findServerPort()) break;
    if (childExited) {
      // Point at the command that actually failed: a global npm install has
      // no repo to run `npm run dev` in, only the bundled server.
      const hint = isProductionMode()
        ? `Run 'node "${DIST_SERVER}"' manually for details.`
        : "Run 'npm run dev' manually for details.";
      throw new Error(`app failed to start. ${hint}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (!(await findServerPort())) {
    throw new Error('server did not start within 15 seconds.');
  }
  if (isProductionMode()) {
    // In production, server serves everything — no Vite client to wait for
    console.log('mdr is ready.');
    return null;
  }
  // Also wait for Vite client to be ready
  while (Date.now() < deadline) {
    if (await findClientPort()) {
      console.log('mdr is ready.');
      return null;
    }
    await delay(POLL_INTERVAL_MS);
  }
  // Server is up but client may still be starting — proceed anyway
  console.log('mdr is ready.');
  return null;
}

async function buildUrl(file, dir) {
  const clientPort = await findClientPort();
  const serverPort = await findServerPort();
  const port = clientPort ?? serverPort ?? DEFAULT_CLIENT_PORT;
  // 127.0.0.1 rather than localhost: browsers prefer ::1 too, so a
  // localhost URL can land on whatever app squats the port on IPv6.
  const baseUrl = `http://127.0.0.1:${port}`;
  if (file) return `${baseUrl}?file=${encodeURIComponent(file)}`;
  if (dir) return `${baseUrl}?dir=${encodeURIComponent(dir)}`;
  return baseUrl;
}

async function openInBrowser(url) {
  // MD_REDLINE_BROWSER overrides the launcher with an explicit command that
  // receives the URL as its argument (e.g. a specific browser binary). Spawned
  // detached so it survives this process exiting, same as the platform defaults
  // below.
  //
  // MDR_BROWSER is the original name, kept as a fallback because it shipped and
  // is documented. Every other variable uses the MD_REDLINE_ prefix, so the new
  // name is the one to reach for; this one can go at a major.
  // First non-EMPTY wins, not first non-undefined: `??` alone would let
  // MD_REDLINE_BROWSER="" discard a working MDR_BROWSER and fall through to the OS
  // default. ports.js documents why blank has to count as unset everywhere.
  const override =
    [process.env.MD_REDLINE_BROWSER, process.env.MDR_BROWSER]
      .map((v) => v?.trim())
      .find((v) => v) ?? '';
  if (override) {
    if (process.platform === 'win32') {
      const needsShell = /\.(?:cmd|bat)$/i.test(override);
      await spawnWindowsBrowser(override, url, { shellCommand: needsShell });
      return;
    }
    await spawnDetached(override, [url], { detached: true });
    return;
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [url]);
    return;
  }
  if (process.platform === 'win32') {
    await openWithWindowsShell(url);
    return;
  }
  if (process.platform === 'linux') {
    await spawnDetached('xdg-open', [url]);
    return;
  }
  console.log(`Open in your browser: ${url}`);
}

function getClaudeDesktopConfigPath() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Write the md-redline MCP entry to Claude Desktop's JSON config file.
 * Idempotent: reports "already configured" on second run. Migrates any
 * legacy `mdr` key from an earlier version of this helper to `md-redline`.
 */
async function installForClaudeDesktop() {
  const configPath = getClaudeDesktopConfigPath();

  // Annotated rather than inferred from `{}`: in a JS file TypeScript grows an
  // object literal's type from the properties assigned to it later, so the
  // reset below (`config = {}`) would then be missing a key it just gained.
  // Every value here belongs to some other MCP server, and this command's one
  // job is to hand them all back unchanged.
  /** @type {Record<string, unknown>} */
  let config = {};
  let existing;
  try {
    existing = await retryTransient(() => readFile(configPath, 'utf8'));
  } catch (err) {
    // Only a missing file may be treated as "start fresh". Every other read
    // failure has to abort, because writing a fresh config over a file we
    // could not read would delete every other MCP server in it.
    if (err.code !== 'ENOENT') {
      throw new Error(
        `Cannot read ${configPath} (${err.code}): ${err.message}\n` +
          'Fix the permissions and retry; refusing to overwrite a config that may hold other MCP servers.',
      );
    }
  }
  if (existing !== undefined) {
    try {
      config = JSON.parse(existing);
    } catch (err) {
      throw new Error(
        `Cannot parse ${configPath}: ${err.message}\nPlease fix the JSON syntax and retry.`,
      );
    }
  }

  if (typeof config !== 'object' || config === null) config = {};
  /** @type {Record<string, unknown>} */
  const mcpServers =
    config.mcpServers && typeof config.mcpServers === 'object'
      ? /** @type {Record<string, unknown>} */ (config.mcpServers)
      : {};

  const hadLegacyKey = Boolean(mcpServers.mdr) && !mcpServers['md-redline'];
  if (hadLegacyKey) {
    mcpServers['md-redline'] = mcpServers.mdr;
    delete mcpServers.mdr;
  }

  if (mcpServers['md-redline'] && !hadLegacyKey) {
    console.log(`[Claude Desktop] md-redline already configured in ${configPath}`);
    return { ok: true, changed: false };
  }

  if (!mcpServers['md-redline']) {
    mcpServers['md-redline'] = { command: 'mdr', args: ['mcp'] };
  }
  config.mcpServers = mcpServers;

  await mkdir(dirname(configPath), { recursive: true });
  // Temp file + rename, never a bare write. This file is not ours: it holds
  // every OTHER MCP server the user has configured, and a truncated write
  // takes all of them down, not just md-redline's entry.
  await atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(
    hadLegacyKey
      ? `[Claude Desktop] Renamed legacy mdr entry to md-redline in ${configPath}`
      : `[Claude Desktop] Wrote md-redline MCP server entry to ${configPath}`,
  );
  return { ok: true, changed: true };
}

/**
 * Register md-redline with Claude Code by invoking `claude mcp add`.
 * Claude Code manages its MCP config via its CLI rather than a plain JSON
 * file, so spawning the CLI is the supported integration point.
 */
async function installForClaudeCode() {
  // Check whether the claude CLI is on PATH.
  const claudeCheck = await new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
  if (!claudeCheck) {
    console.log(
      '[Claude Code] claude CLI not found on PATH — skipping. Install Claude Code or run `claude mcp add md-redline mdr mcp` manually.',
    );
    return { ok: false, changed: false };
  }

  // Check whether md-redline is already registered.
  const listOutput = await new Promise((resolve) => {
    const child = spawn('claude', ['mcp', 'list', '--scope', 'user'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.once('error', () => resolve(''));
    child.once('exit', () => resolve(out));
  });
  if (/^\s*md-redline\b/m.test(listOutput)) {
    console.log('[Claude Code] md-redline already registered.');
    return { ok: true, changed: false };
  }

  const addResult = await new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'md-redline', '--', 'mdr', 'mcp'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => resolve({ ok: false, error: err.message }));
    child.once('exit', (code) =>
      resolve({
        ok: code === 0,
        error: code === 0 ? null : stderr.trim() || `exited with code ${code}`,
      }),
    );
  });

  if (!addResult.ok) {
    console.log(`[Claude Code] failed to register md-redline: ${addResult.error}`);
    return { ok: false, changed: false };
  }
  console.log('[Claude Code] Registered md-redline via `claude mcp add`.');
  return { ok: true, changed: true };
}

async function installMcpConfig(target) {
  // `changed` and `error` are each set by only one of the two shapes pushed
  // here, and the reporting below reads both across every result.
  /** @type {Array<{ name: string; ok: boolean; changed?: boolean; error?: string }>} */
  const results = [];
  if (target === 'claude-desktop' || target === 'all') {
    try {
      results.push({ name: 'Claude Desktop', ...(await installForClaudeDesktop()) });
    } catch (err) {
      results.push({
        name: 'Claude Desktop',
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
  if (target === 'claude-code' || target === 'all') {
    try {
      results.push({ name: 'Claude Code', ...(await installForClaudeCode()) });
    } catch (err) {
      results.push({
        name: 'Claude Code',
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  // A thrown installer error was being captured here and never printed, so a
  // failed install exited 1 with nothing on stderr to say why. installForClaudeCode
  // reports its own failures and sets no `error`, so this never doubles up.
  for (const result of results) {
    if (!result.ok && result.error) console.error(`[${result.name}] ${result.error}`);
  }

  const anyChanged = results.some((r) => r.changed);
  if (anyChanged) {
    console.log('');
    console.log('Restart the affected client(s) to pick up the change.');
  }
  if (results.every((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

async function runMcpStdio() {
  const distMcp = join(APP_DIR, 'dist', 'mcp-stdio.js');
  if (!isProductionMode()) {
    throw new Error(
      'mdr mcp requires the production build. Run `npm run build` first, then re-link or reinstall mdr.',
    );
  }
  try {
    statSync(distMcp);
  } catch {
    throw new Error(`mdr mcp bundle missing at ${distMcp}. Run \`npm run build\`.`);
  }

  // Refuse to start with a stale bundle. If any source file under
  // server/mcp-stdio/ is newer than the bundle, we'd silently run pre-edit
  // code (which is exactly what bit us when iterating on this tool).
  // `npm run dev` watches and rebuilds the bundle automatically, so this
  // only triggers when developing outside the dev script.
  {
    // Inline staleness check (no broad try/catch — only specific filesystem
    // race errors are swallowed). The inner `try { statSync(p) } catch` handles
    // entries that disappear between readdir and stat. The outer block lets
    // unexpected errors surface instead of being misclassified as staleness.
    const bundleStat = (() => {
      try {
        return statSync(distMcp);
      } catch {
        return null;
      }
    })();
    if (bundleStat) {
      // The MCP bundle pulls in `server/**`, modules from `src/lib/`
      // (agent-prompts, comment-parser), and `src/types.ts` (comment-parser
      // imports getEffectiveStatus). Scan all three roots so edits to any
      // compiled dependency trip the staleness check.
      //
      // Staleness is binary — the moment we find one source file newer than
      // the bundle, we know enough to throw. Don't walk the rest of the tree
      // (this runs on every `mdr mcp` startup, so the early-exit matters).
      const bundleMtime = bundleStat.mtimeMs;
      const stack = [
        join(APP_DIR, 'server'),
        join(APP_DIR, 'src', 'lib'),
        join(APP_DIR, 'src', 'types.ts'),
      ];
      let stalePath = null;
      let staleAgeSec = 0;
      outer: while (stack.length) {
        const p = stack.pop();
        if (!p) continue;
        let entryStat;
        try {
          entryStat = statSync(p);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          let entries;
          try {
            entries = readdirSync(p);
          } catch {
            continue;
          }
          for (const entry of entries) stack.push(join(p, entry));
        } else if (p.endsWith('.ts')) {
          // Skip test files — they don't contribute to the bundled output,
          // so editing only a *.test.ts must not flag staleness.
          if (p.endsWith('.test.ts') || p.endsWith('.spec.ts')) continue;
          if (entryStat.mtimeMs > bundleMtime) {
            stalePath = p;
            staleAgeSec = Math.round((entryStat.mtimeMs - bundleMtime) / 1000);
            break outer;
          }
        }
      }
      if (stalePath) {
        throw new Error(
          `mdr mcp bundle is stale (${stalePath} is ${staleAgeSec}s newer than dist/mcp-stdio.js).\n` +
            `Run \`npm run build\` (or \`npm run dev\` which rebuilds on save).`,
        );
      }
    }
  }

  // Dynamic import so the SDK is only loaded when the mcp subcommand is invoked
  const mod = await import(pathToFileURL(distMcp).href);

  // Bin owns the baseUrl state so there's no module-level mutable in the
  // mcp-stdio module. runMcpServer reads it via getBaseUrl() on every tool
  // call, after ensureServerRunning() has had a chance to refresh it.
  let currentBaseUrl = `http://127.0.0.1:${DEFAULT_CLIENT_PORT}`;
  await mod.runMcpServer({
    getBaseUrl: () => currentBaseUrl,
    openInBrowser,
    ensureServerRunning: async () => {
      await ensureServerRunning();
      const port = (await findClientPort()) ?? (await findServerPort()) ?? DEFAULT_CLIENT_PORT;
      currentBaseUrl = `http://127.0.0.1:${port}`;
    },
  });
}

async function main() {
  if (process.argv[2] === '-h' || process.argv[2] === '--help') {
    printHelp();
    return;
  }

  if (process.argv[2] === '-v' || process.argv[2] === '--version') {
    console.log(CLI_VERSION);
    return;
  }

  if (process.argv[2] === '--stop') {
    await stopServer();
    return;
  }

  if (process.argv[2] === '--restrict') {
    await enableRestrictedMode();
    return;
  }

  if (process.argv[2] === '__open') {
    // Internal, undocumented seam: launch the browser for a URL and exit
    // immediately, without booting a server. Lets the browser-open regression
    // test drive openInBrowser() in isolation — the worst case for the Windows
    // detached-teardown race — and honors MD_REDLINE_BROWSER like every other path.
    const target = process.argv[3];
    if (target) await openInBrowser(target);
    return;
  }

  if (process.argv[2] === '__first-launch') {
    // Internal, undocumented seam, same idea as __open above: print which
    // trust disclosure this invocation would print and exit, without booting a
    // server. The answer is otherwise only observable as a line or two of text
    // in the middle of a real startup, which a test cannot reach without
    // spawning the whole app.
    console.log(await trustDisclosureState());
    return;
  }

  if (process.argv[2] === '__port') {
    // Internal, undocumented seam, same idea as __open above: print the API port
    // this CLI resolved and exit, without booting or contacting anything. The port
    // is otherwise unobservable from outside, because it only seeds the fallback
    // scan inside findServerPort, and the one command that would reveal it
    // (--stop) kills whatever it finds. Lets a test prove the CLI, the server and
    // vite.config all answer with the same port for the same environment.
    console.log(DEFAULT_SERVER_PORT);
    return;
  }

  if (process.argv[2] === 'mcp') {
    if (process.argv[3] === 'install') {
      // mdr mcp install              → both Claude Code and Claude Desktop
      // mdr mcp install --claude-code → just Claude Code (via `claude mcp add`)
      // mdr mcp install --claude-desktop → just Claude Desktop (JSON config)
      const flag = process.argv[4];
      let target = 'all';
      if (flag === '--claude-code') target = 'claude-code';
      else if (flag === '--claude-desktop') target = 'claude-desktop';
      else if (flag && flag.startsWith('-')) {
        console.error(`Unknown flag for 'mcp install': ${flag}`);
        console.error('Supported: --claude-code, --claude-desktop, or omit to install both.');
        process.exitCode = 1;
        return;
      }
      await installMcpConfig(target);
      return;
    }
    try {
      await runMcpStdio();
    } catch (error) {
      console.error(`mdr mcp failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    const { file, dir } = await resolveTarget(process.argv[2] ?? '');
    let versionInfo = await ensureServerRunning();

    // Grant the server access to the target path before opening in browser
    const targetPath = file || dir;
    if (targetPath) {
      const serverPort = await findServerPort();
      if (serverPort) {
        try {
          const grantRes = await fetch(`http://127.0.0.1:${serverPort}/api/grant-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath }),
            signal: AbortSignal.timeout(2_000),
          });
          if (!grantRes.ok) {
            console.error(
              `Warning: server refused access to ${targetPath} (HTTP ${grantRes.status}); it may open as access denied.`,
            );
          }
        } catch {
          /* server will enforce its own checks */
        }
      }
    }

    const url = await buildUrl(file, dir);

    try {
      await openInBrowser(url);
      console.log(`Opened in browser: ${url}`);
    } catch {
      console.log(`Open in your browser: ${url}`);
    }

    if (!versionInfo) {
      const serverPort = await findServerPort();
      if (serverPort) versionInfo = await getServerVersionInfo(serverPort);
    }
    if (versionInfo?.updateCheckPending) {
      const serverPort = await findServerPort();
      if (serverPort) versionInfo = await waitForUpdateCheck(serverPort, versionInfo);
    }
    if (versionInfo?.latest && isNewerVersion(versionInfo.latest, CLI_VERSION)) {
      console.log(
        `Update available: ${CLI_VERSION} -> ${versionInfo.latest}. Run: npm install -g md-redline@latest`,
      );
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

await main();
