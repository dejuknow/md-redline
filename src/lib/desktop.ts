declare global {
  interface Window {
    /** Set to true by the desktop shell's init script (src-tauri/src/main.rs,
     *  DESKTOP_FLAG_SCRIPT) before the app's own scripts run. Absent in a
     *  browser. */
    __mdrDesktop?: boolean;
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
