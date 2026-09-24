/**
 * Formatting for `mdr sessions`. Kept apart from cli.js so the table can be
 * tested without a server, the same split as ports.js.
 */

/**
 * The subset of a public ReviewSession (server/review-sessions.ts) the table
 * reads. Dates arrive as ISO strings because they went through JSON.
 *
 * @typedef {object} SessionRow
 * @property {string} id
 * @property {string} origin
 * @property {string} [clientId]
 * @property {string[]} filePaths
 * @property {string} createdAt
 * @property {string} lastHeartbeatAt
 */

/** Long enough to tell per-process `mcp_<uuid>` callers apart. */
const CALLER_WIDTH = 12;

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * @param {string} path
 * @param {string} homeDir
 * @returns {string}
 */
function shortenHome(path, homeDir) {
  if (!homeDir) return path;
  if (path === homeDir) return '~';
  for (const sep of ['/', '\\']) {
    if (path.startsWith(homeDir + sep)) return `~${path.slice(homeDir.length)}`;
  }
  return path;
}

/**
 * @param {SessionRow[]} sessions
 * @param {{ now: number, homeDir: string }} opts
 * @returns {string}
 */
export function formatSessions(sessions, { now, homeDir }) {
  if (sessions.length === 0) return 'No open review sessions.';

  const header = ['ID', 'ORIGIN', 'CALLER', 'OPENED', 'HEARTBEAT', 'FILES'];
  const rows = [...sessions]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((s) => [
      s.id,
      s.origin,
      s.clientId ? s.clientId.slice(0, CALLER_WIDTH) : '-',
      `${formatAge(now - Date.parse(s.createdAt))} ago`,
      `${formatAge(now - Date.parse(s.lastHeartbeatAt))} ago`,
      s.filePaths.map((p) => shortenHome(p, homeDir)).join(', '),
    ]);

  // FILES is last and unpadded, so a long path list never widens the others.
  const widths = header
    .slice(0, -1)
    .map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  /** @param {string[]} cells */
  const line = (cells) =>
    cells
      .map((c, i) => (i < widths.length ? c.padEnd(widths[i]) : c))
      .join('  ')
      .trimEnd();

  const count = `${sessions.length} open review session${sessions.length === 1 ? '' : 's'}`;
  return [count, '', line(header), ...rows.map(line)].join('\n');
}
