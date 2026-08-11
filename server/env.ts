/**
 * Server-side environment resolution. The port resolvers live in `bin/ports.js`,
 * which explains why they are plain JavaScript and why every reader has to share
 * them; they are re-exported here so server code has one import. Anything
 * server-only stays in this file.
 */

export { FALLBACK_PORT, resolveApiPort } from '../bin/ports.js';
import { resolvePort } from '../bin/ports.js';
/**
 * Re-exported rather than defined here for the same reason as the ports: the
 * CLI writes `.md-redline.json` too, and the two sides have to agree on which
 * file that is. See `bin/home-dir.js`.
 */
export { resolveHomeDir } from '../bin/home-dir.js';

export const FALLBACK_VITE_PORT = 5188;

/** Port for the Vite dev client. No alias: this one only ever had the prefixed name. */
export function resolveVitePort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort(env, ['MD_REDLINE_VITE_PORT'], FALLBACK_VITE_PORT);
}
