/**
 * Port resolution, done once for every reader.
 *
 * This lives in `bin/` rather than `server/` for a packaging reason: `files` in
 * package.json ships `bin/` and `dist/`, and the CLI needs this at runtime from an
 * npm install. The server gets it bundled into `dist/server.js` by esbuild, and
 * `vite.config.ts` imports it through `server/env.ts` to aim its dev proxy.
 *
 * It is plain JavaScript so the CLI can import it directly, with types read from
 * the JSDoc below by every side that imports it: that is how
 * `bin/version-compare.js` is already shared between this CLI and
 * `server/update-check.ts`. The CLI is dependency-free with no build step of its
 * own, so a TypeScript module would have to be hand-copied into it, and a hand-copy
 * is what this file exists to delete. The three readers used to disagree for real:
 * `PORT=7100`, an alias the README documents, bound the server and aimed the dev
 * proxy at 7100 while the CLI scanned from 6373, because the CLI's copy read only
 * the prefixed name.
 */

/** 6373 spells "MDR" on a phone keypad, clear of the 3000-3010 range Next/Nest/CRA contend for. */
export const FALLBACK_PORT = 6373;

/**
 * First non-EMPTY candidate wins, and it has to be a port a server could bind.
 *
 * Blank counts as unset. A plain `??` keeps an empty string, which is how
 * `MD_REDLINE_PORT=""` used to beat a working `PORT` and reach
 * `Number.parseInt('')`. The resulting NaN was not just a wrong port: the server's
 * scan loop runs while `p < DEFAULT_PORT + MAX_PORT_ATTEMPTS`, false on the first
 * comparison, so it tried no port at all and died with "No available port found
 * (tried NaN-NaN)" while ignoring the port the user had set. An empty value is
 * easy to produce by accident: `export MD_REDLINE_PORT="$SOME_UNSET_VAR"` in a
 * profile, or a blank entry in a CI env block.
 *
 * A non-empty value that is not a usable port warns and defers to the next
 * candidate rather than throwing. The server reads this while its module is still
 * evaluating, before the startup chain that renders errors as one readable line,
 * and a typo in a port should not brick a local tool.
 *
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[]} names Candidates in priority order.
 * @param {number} fallback Used when no candidate holds a usable port.
 * @returns {number} A port between 1 and 65535.
 */
export function resolvePort(env, names, fallback) {
  for (const name of names) {
    const raw = env[name];
    const value = raw?.trim();
    if (!value) continue;
    // Number, not parseInt: parseInt('7100nonsense') is 7100, which would start
    // the server somewhere the user never asked for.
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    console.warn(`[md-redline] ${name}="${raw}" is not a valid port number; ignoring it.`);
  }
  return fallback;
}

/**
 * The API server's port. `PORT` is a documented alias for `MD_REDLINE_PORT`, kept
 * because it shipped; the prefixed name wins.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {number} A port between 1 and 65535.
 */
export function resolveApiPort(env = process.env) {
  return resolvePort(env, ['MD_REDLINE_PORT', 'PORT'], FALLBACK_PORT);
}
