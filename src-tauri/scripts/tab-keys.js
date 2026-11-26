// Tab shortcuts for Windows and Linux, injected into the mdr page by the
// desktop shell (src/main.rs). Those platforms have no app menu to carry
// them, so a key listener does it: Ctrl+W closes the active tab and
// Ctrl+Shift+T reopens the last closed one, through the hooks App.tsx
// registers while it is mounted. With no tab open, Ctrl+W does nothing
// rather than close the window. On macOS the File menu carries both.
(function () {
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      var key = (e.key || '').toLowerCase();
      var hook = null;
      if (key === 'w' && !e.shiftKey) hook = window.__mdrCloseActiveTab;
      else if (key === 't' && e.shiftKey) hook = window.__mdrReopenClosedTab;
      else return;
      e.preventDefault();
      if (typeof hook === 'function') hook();
    },
    true,
  );
})();
