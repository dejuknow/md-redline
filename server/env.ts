/**
 * Server-side environment resolution. The port resolvers live in `bin/ports.js`,
 * which explains why they are plain JavaScript and why every reader has to share
 * them; they are re-exported here so server code has one import. Anything
 * server-only stays in this file.
 */

export {
  FALLBACK_PORT,
  FALLBACK_VITE_PORT,
  resolveApiPort,
  resolveNamedApiPort,
  resolveStrictApiPort,
  resolveVitePort,
} from '../bin/ports.js';
/**
 * Re-exported rather than defined here for the same reason as the ports: the
 * CLI writes `.md-redline.json` too, and the two sides have to agree on which
 * file that is. See `bin/home-dir.js`.
 */
export { resolveHomeDir } from '../bin/home-dir.js';
