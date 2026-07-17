import { execSync } from 'child_process';

export function buildKillCommand(port, platform = process.platform) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (platform === 'win32') {
    return `netstat -ano | findstr 127.0.0.1:${port} | findstr LISTENING`;
  }
  // -sTCP:LISTEN restricts matches to listeners. Without it, lsof also
  // returns PIDs with outbound connections to the port — including this
  // CLI itself after it probes /api/version or /api/shutdown — and the
  // subsequent `kill` would SIGTERM the caller mid-upgrade.
  // @127.0.0.1 restricts matches to the IPv4 loopback socket mdr binds.
  // Another app can hold the same port number on IPv6 (e.g. a Nest server
  // on *:PORT); without the scoping, `kill` would SIGTERM that app too.
  return `lsof -iTCP@127.0.0.1:${port} -sTCP:LISTEN -t | xargs kill 2>/dev/null`;
}

export function killPort(port, {
  platform = process.platform,
  exec = (cmd, opts) => execSync(cmd, opts),
} = {}) {
  const command = buildKillCommand(port, platform);
  if (!command) return false;
  try {
    if (platform === 'win32') {
      const output = exec(command, { encoding: 'utf8' }) ?? '';
      const pids = new Set(
        String(output)
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/).pop())
          .filter(Boolean),
      );
      for (const pid of pids) {
        if (pid && pid !== '0') {
          try { exec(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch { /* already exited */ }
        }
      }
    } else {
      exec(command, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

export async function checkServer(port, {
  fetchFn = fetch,
  timeoutMs = 1_000,
} = {}) {
  try {
    // 127.0.0.1, never `localhost`: the server binds IPv4 loopback only,
    // while `localhost` resolves to ::1 first. If another app holds the
    // same port on IPv6, a localhost probe reaches that app and the CLI
    // concludes its own healthy server is not running.
    const response = await fetchFn(`http://127.0.0.1:${port}/api/config`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    // Validate this is actually mdr's /api/config — other dev servers
    // (e.g. Next.js) return 200 with their SPA shell for unknown paths,
    // which would otherwise fool the port scan and hijack the browser open.
    const data = await response.json();
    return !!data && typeof data === 'object' && typeof data.homeDir === 'string';
  } catch {
    return false;
  }
}

export async function gracefulShutdown(port, {
  fetchFn = fetch,
  checkServerFn = (p) => checkServer(p, { fetchFn }),
  requestTimeoutMs = 2_000,
  deadlineMs = 3_000,
  pollMs = 250,
  now = () => Date.now(),
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // The server handler returns JSON then calls `setImmediate(process.exit)`,
  // so the response socket can be torn down before fetch fully resolves on
  // some runtimes. Treat a dropped connection the same as a 2xx reply and
  // let the poll below decide success — otherwise we'd fall back to
  // killPort during a race where the server is moments from exiting.
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      // Server middleware rejects POSTs without this header with 415 as a
      // CSRF guard against text/plain form submits.
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return false;
  } catch {
    // Probably ECONNRESET from the server exiting mid-response; fall through.
  }

  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    if (!(await checkServerFn(port))) return true;
    await delay(pollMs);
  }
  return false;
}
