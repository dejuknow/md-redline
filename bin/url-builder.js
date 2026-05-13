/**
 * Compose user-facing mdr URLs honoring MDR_HOST.
 *
 * When MDR_HOST is set the URLs we hand to the user (browser, console,
 * MCP tool baseUrl) point at that hostname so a laptop browser can reach
 * a remote dev host (e.g. Cloud Desktop FQDN). When unset the URL falls
 * back to `localhost`, preserving the historical default for local-only
 * users.
 *
 * Internal CLI->server fetches (port probes, version checks, grant-access)
 * still hard-code `localhost` because they always run on the same host as
 * the server. Only URLs we expose to the user (or to the MCP client, which
 * relays the URL to the user's chat UI) flow through here.
 */
export function getDisplayHost(env = process.env) {
  const raw = env.MDR_HOST;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return 'localhost';
}

export function buildBrowserUrl({ port, file, dir, env = process.env } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('buildBrowserUrl requires a valid port');
  }
  const host = getDisplayHost(env);
  const baseUrl = `http://${host}:${port}`;
  if (file) return `${baseUrl}?file=${encodeURIComponent(file)}`;
  if (dir) return `${baseUrl}?dir=${encodeURIComponent(dir)}`;
  return baseUrl;
}
