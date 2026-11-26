// Tab shortcuts the desktop shell (src/main.rs) injects into the mdr page,
// on every platform, for keys an app menu cannot carry. MENU_KEYS is filled
// in by the shell: true on macOS, whose menus carry New Tab, Close Tab,
// Reopen Closed Tab and Cmd+1 to Cmd+9; false on Windows and Linux, which
// have no app menu, so this listener takes those keys there.
//
// - Ctrl+Tab / Ctrl+Shift+Tab: next / previous tab, everywhere. WKWebView
//   never hands Ctrl+Tab to the macOS menu, so even there the key is read
//   here; the Go menu only shows it.
// - Windows and Linux: Ctrl+T opens a new tab (the file picker, as the tab
//   strip's "+" does), Ctrl+W closes the active tab, Ctrl+Shift+T reopens
//   the last closed one, and Ctrl+1 to Ctrl+8 go to that tab, Ctrl+9 to the
//   last. With no tab open, Ctrl+W does nothing rather than close the window.
//
// Each goes through a hook App.tsx registers while it is mounted.
(function () {
  var MENU_KEYS = __MDR_MENU_KEYS__;
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      var key = (e.key || '').toLowerCase();
      // [hook name, argument]
      var action = null;
      if (key === 'tab') {
        action = ['__mdrSwitchTab', e.shiftKey ? -1 : 1];
      } else if (!MENU_KEYS) {
        // By position, as browsers do, so layouts that need Shift for digits work.
        var digit = /^Digit([1-9])$/.exec(e.code || '') || /^([1-9])$/.exec(key);
        if (digit && !e.shiftKey) action = ['__mdrSelectTab', Number(digit[1])];
        else if (key === 'w' && !e.shiftKey) action = ['__mdrCloseActiveTab'];
        else if (key === 't') action = [e.shiftKey ? '__mdrReopenClosedTab' : '__mdrNewTab'];
      }
      if (!action) return;
      e.preventDefault();
      var hook = window[action[0]];
      if (typeof hook === 'function') {
        if (action.length > 1) hook(action[1]);
        else hook();
      }
    },
    true,
  );
})();
