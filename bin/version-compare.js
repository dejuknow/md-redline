import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Strict x.y.z compare: true only when candidate is a plain three-part
 * numeric version strictly newer than current. Prerelease tags, missing
 * segments, or non-string input return false, conservatively suppressing
 * an update notice rather than risking a bogus one. mdr publishes plain
 * x.y.z only.
 *
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  const a = parseTriple(candidate);
  const b = parseTriple(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseTriple(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * The version installed in appDir right now, read from its package.json on
 * every call. A long-running process (the `mdr mcp` an MCP client keeps
 * open) must not trust the version it started with: after an upgrade the
 * files on disk, and any server started from them, are the new version, and
 * comparing the server against the stale one restarts it on every tool call
 * (#134). Null when the file is missing or mid-write during an install: the
 * caller should then leave a running server alone rather than guess, since
 * the files it would restart from may be half-replaced too.
 *
 * @param {string} appDir
 * @returns {string | null}
 */
export function readInstalledVersion(appDir) {
  try {
    const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
