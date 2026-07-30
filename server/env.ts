import { homedir } from 'os';

/**
 * Server-side environment resolution. The port resolvers live in `bin/ports.js`,
 * which explains why they are plain JavaScript and why every reader has to share
 * them; they are re-exported here so server code has one import. Anything
 * server-only stays in this file.
 */

export { FALLBACK_PORT, resolveApiPort } from '../bin/ports.js';
import { resolvePort } from '../bin/ports.js';

export const FALLBACK_VITE_PORT = 5188;

/** Port for the Vite dev client. No alias: this one only ever had the prefixed name. */
export function resolveVitePort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort(env, ['MD_REDLINE_VITE_PORT'], FALLBACK_VITE_PORT);
}

/**
 * Resolves the base directory for md-redline's preferences file.
 *
 * Blank counts as unset here too. A plain `?? homedir()` kept an empty string,
 * and an empty base directory is not an obvious failure: `.md-redline.json` then
 * resolves against the current working directory, so trusted roots and the
 * update-check cache get written wherever the user happened to launch from and
 * silently fail to persist across launches.
 *
 * Both `server/index.ts` and `server/update-check.ts` read this independently.
 * The update checker is constructed without a `homeDir` option, so its own read
 * is live in production rather than a test-only fallback.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MD_REDLINE_HOME?.trim() || homedir();
}
