import { FALLBACK_PORT } from './ports.js';
import { sameDir } from './server-control.js';

/**
 * How many ports the desktop app scans from FALLBACK_PORT when it looks for a
 * server. Mirrors DEFAULT_SERVER_PORT and MAX_PORT_SCAN in src-tauri/src/main.rs.
 */
export const APP_PORT_SCAN = 10;

/**
 * Whether the CLI should hand an open to the mdr desktop app (via its mdr://
 * link) instead of the browser.
 *
 * The app finds its server on its own: a server serving the user's home, on a
 * port in FALLBACK_PORT..FALLBACK_PORT+APP_PORT_SCAN. A link carries only a
 * path or a review id, so when this CLI is talking to some other server (a
 * different MD_REDLINE_HOME, or a port outside that range from MD_REDLINE_PORT
 * or PORT), the app would open the target on the wrong instance, or look up a
 * review that server never had. Those runs keep the browser, which gets the
 * exact URL. So does any explicit browser override, which is a request for that
 * browser and is also how tests keep off an installed app.
 *
 * @param {{
 *   platform: string;
 *   browserOverride: string;
 *   resolvedHome: string;
 *   userHome: string;
 *   serverPort: number | null;
 * }} input
 * @returns {boolean}
 */
export function shouldPreferApp({ platform, browserOverride, resolvedHome, userHome, serverPort }) {
  if (platform !== 'darwin' || browserOverride) return false;
  if (serverPort === null || serverPort < FALLBACK_PORT) return false;
  if (serverPort >= FALLBACK_PORT + APP_PORT_SCAN) return false;
  return sameDir(resolvedHome, userHome);
}
