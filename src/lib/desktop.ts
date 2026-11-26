declare global {
  interface Window {
    /** Set to true by the desktop shell's init script (src-tauri/src/main.rs,
     *  DESKTOP_FLAG_SCRIPT) before the app's own scripts run. Absent in a
     *  browser. */
    __mdrDesktop?: boolean;
    /** Set by the same init script to the desktop app's own version, which
     *  differs from the npm package version. */
    __mdrDesktopVersion?: string;
    /** Set by the same init script where the shell can deliver system
     *  notifications (the macOS app, run from its bundle). Shows the agent
     *  notifications setting (#244). */
    __mdrDesktopNotifications?: boolean;
  }
}

/**
 * Whether the page runs inside the desktop app. The one signal for it: the
 * shell sets `window.__mdrDesktop` on every platform before the page loads, so
 * nothing here sniffs Tauri's own globals. The desktop app binds keys a
 * browser keeps for its own tabs (New Tab, Close Tab, Reopen Closed Tab), and
 * the palette and the shortcuts panel list those keys only here.
 */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.__mdrDesktop === true;
}

/** The desktop app's own version, or null outside the desktop app (or when the shell did not set it). */
export function desktopAppVersion(): string | null {
  if (!isDesktopApp()) return null;
  const v = window.__mdrDesktopVersion;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Whether the desktop shell can deliver agent notifications (#244). The shell
 * sets `window.__mdrDesktopNotifications` only where it can; elsewhere the
 * setting stays hidden and nothing is detected.
 */
export function desktopNotificationsSupported(): boolean {
  return isDesktopApp() && window.__mdrDesktopNotifications === true;
}
