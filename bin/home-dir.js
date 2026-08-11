/**
 * Where `.md-redline.json` lives.
 *
 * In `bin/` for the same reason `ports.js` is: the CLI reads and writes that
 * file too (`mdr --restrict`, the first-launch disclosure) and cannot import a
 * `.ts` module. Both sides resolving it separately is not a style problem, it
 * is a correctness one. With MD_REDLINE_HOME set, a CLI using bare `homedir()`
 * locks and writes a file the server never reads, then reports success, and
 * the cross-process lock the two are supposed to share is taken on two
 * different paths.
 *
 * Types live in `home-dir.d.ts`. `server/env.ts` re-exports this.
 */

import { homedir } from 'os';

/**
 * Blank counts as unset. A plain `??` kept an empty string, and an empty base
 * directory is not an obvious failure: `.md-redline.json` then resolves
 * against the current working directory, so trusted roots and the update-check
 * cache get written wherever the user happened to launch from and silently
 * fail to persist across launches.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveHomeDir(env = process.env) {
  return env.MD_REDLINE_HOME?.trim() || homedir();
}
