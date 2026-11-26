// Desktop shell for md-redline. A thin client: discovers (or starts) the
// local mdr server and points a single webview window at it. All product
// logic lives in the web app; this binary only handles window lifecycle,
// the mdr:// deep link, and .md file associations.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

// Mirrors bin/cli.js: 6373 ("MDR" on a phone keypad) for the server,
// 5188 for the Vite dev client, +10 scan range, port file in tmpdir.
const DEFAULT_SERVER_PORT: u16 = 6373;
const DEFAULT_CLIENT_PORT: u16 = 5188;
const MAX_PORT_SCAN: u16 = 10;
/// Starting zoom for the webview; Cmd +/- adjusts from here at runtime
/// (zoomHotkeysEnabled). Applied once so a manual zoom change is never
/// clobbered by later doc opens.
const DEFAULT_ZOOM: f64 = 1.25;

/// Injected at document start on every navigation. The rendered markdown
/// renders external links as `<a target="_blank">`, which a WKWebView
/// silently swallows (no new-window handler), so clicks appear dead. This
/// capturing listener turns an external-link click into a top-level
/// navigation, which the shell's on_navigation handler then hands to the
/// system browser. Local `.md` links (data-mdr-local-md) and same-origin
/// links are left for the SPA's own click handler.
const EXTERNAL_LINK_SCRIPT: &str = r#"(function () {
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('data-mdr-local-md')) return;
    var href = a.href;
    if (!href) return;
    var scheme = (href.split(':')[0] || '').toLowerCase();
    var isWeb = scheme === 'http' || scheme === 'https';
    var external = (isWeb && a.origin && a.origin !== location.origin) || scheme === 'mailto' || scheme === 'tel';
    if (!external) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = href;
  }, true);
})();"#;

/// Overlay title bar support (macOS), injected so the shell styles the app's
/// chrome from outside. The native title bar is gone (TitleBarStyle::Overlay),
/// so this script:
/// - marks the page `data-shell="mac"` and sets the app's documented
///   `--window-inset-left` / `--window-inset-top` hooks (AGENTS.md, "Desktop
///   shell hooks") on whichever row sits under the traffic lights: the
///   sidebar's top row when it is open, the collapsed rail plus the tab strip
///   when it is collapsed, the tab strip alone in focus mode;
/// - drops the insets in native full screen, where macOS hides the lights;
/// - makes the top 44px strip drag the window (double-click zooms), skipping
///   anything interactive. Geometry instead of `data-tauri-drag-region`
///   attributes, because those only match the exact element clicked and the
///   app's markup is not ours to annotate from here.
#[cfg(target_os = "macos")]
const SHELL_CHROME_SCRIPT: &str = r#"(function () {
  var root = document.documentElement;
  root.setAttribute('data-shell', 'mac');
  // The lights sit at fixed window points (traffic_light_position) while the
  // page is zoomed to DEFAULT_ZOOM (filled in for __MDR_ZOOM__), so the room
  // they need is kept in points and converted to CSS px: the right edge of
  // the lights plus a gap, and their bottom plus a gap. WKWebView exposes
  // no zoom to the page (outerWidth / innerWidth stays 1).
  var Z = __MDR_ZOOM__, LIGHTS_RIGHT_PT = 98, LIGHTS_BOTTOM_PT = 43;
  root.style.setProperty('--mdr-lights-r', (LIGHTS_RIGHT_PT / Z).toFixed(1) + 'px');
  root.style.setProperty('--mdr-lights-b', (LIGHTS_BOTTOM_PT / Z).toFixed(1) + 'px');
  var on = 'html[data-shell="mac"]:not([data-fullscreen]) ';
  var css = [
    // Sidebar open: its top row starts at 8px and pads 4px past the inset.
    on + '[data-sidebar-top] { --window-inset-left: calc(var(--mdr-lights-r) - 12px); }',
    // Sidebar collapsed: the rail's icons drop below the lights (rail top
    // 8px, plus its own 5px), and the tab strip (from 56px) clears them.
    on + '[data-sidebar-rail] { --window-inset-top: calc(var(--mdr-lights-b) - 13px); }',
    on + '[data-app-root]:has([data-sidebar-rail]) [data-doc-strip] { --window-inset-left: max(0px, calc(var(--mdr-lights-r) - 56px)); }',
    // No sidebar (focus mode): the tab strip starts at 8px.
    on + '[data-app-root]:not(:has([data-sidebar-rail], [data-sidebar-panel])) [data-doc-strip] { --window-inset-left: calc(var(--mdr-lights-r) - 8px); }'
  ].join('\n');
  function addStyle() {
    if (document.getElementById('mdr-shell-chrome')) return;
    var s = document.createElement('style');
    s.id = 'mdr-shell-chrome';
    s.textContent = css;
    (document.head || root).appendChild(s);
  }
  if (document.head) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);

  // Native full screen hides the lights.
  function syncFullscreen() {
    var fs = Math.abs(window.outerHeight - screen.height) < 2 && Math.abs(window.outerWidth - screen.width) < 2;
    if (fs) root.setAttribute('data-fullscreen', ''); else root.removeAttribute('data-fullscreen');
  }
  syncFullscreen();
  window.addEventListener('resize', syncFullscreen);

  var STRIP = 44;
  var INTERACTIVE = 'button, a, input, textarea, select, label, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable=""], [contenteditable="true"], [draggable="true"]';
  function inStrip(e) {
    if (e.button !== 0 || e.clientY > STRIP || root.hasAttribute('data-fullscreen')) return false;
    var t = e.target;
    return !(t && t.closest && t.closest(INTERACTIVE));
  }
  function invoke(cmd) {
    var ipc = window.__TAURI_INTERNALS__;
    if (ipc && ipc.invoke) ipc.invoke('plugin:window|' + cmd).catch(function () {});
  }
  document.addEventListener('mousedown', function (e) {
    if (!inStrip(e)) return;
    if (e.detail === 2) { e.preventDefault(); invoke('internal_toggle_maximize'); return; }
    e.preventDefault();
    invoke('start_dragging');
  });
})();"#;

/// Close Tab (Ctrl+W) and Reopen Closed Tab (Ctrl+Shift+T) for Windows and
/// Linux, which have no app menu to carry the shortcuts. See the script for
/// the rules; macOS uses the File menu instead.
#[cfg(not(target_os = "macos"))]
const TAB_KEY_SCRIPT: &str = include_str!("../scripts/tab-keys.js");

/// Asks the app to close its active tab; falls back to hiding the window
/// when no tab is open or the app is not loaded (loading or error page).
#[cfg(target_os = "macos")]
fn close_tab_or_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let target = win.clone();
    let asked = win.eval_with_callback(
        "window.__mdrCloseActiveTab ? window.__mdrCloseActiveTab() === true : false",
        move |result| {
            if result.trim() != "true" {
                let _ = target.hide();
            }
        },
    );
    if asked.is_err() {
        let _ = win.hide();
    }
}

/// The default macOS menu, except that Cmd+W closes the active tab, Close
/// Window moves to Shift+Cmd+W and Shift+Cmd+T reopens the last closed tab (as
/// in browsers).
#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let about = AboutMetadata {
        name: Some(app.package_info().name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &sep()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, MENU_CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
                    &MenuItem::with_id(
                        app,
                        MENU_REOPEN_TAB,
                        "Reopen Closed Tab",
                        true,
                        Some("CmdOrCtrl+Shift+T"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        MENU_CLOSE_WINDOW,
                        "Close Window",
                        true,
                        Some("CmdOrCtrl+Shift+W"),
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg(target_os = "macos")]
const MENU_CLOSE_TAB: &str = "close-tab";
#[cfg(target_os = "macos")]
const MENU_REOPEN_TAB: &str = "reopen-tab";
#[cfg(target_os = "macos")]
const MENU_CLOSE_WINDOW: &str = "close-window";

/// Asks the app to reopen its last closed tab, and brings the window back
/// when one reopened (closing the last tab hides it), as browsers do. Does
/// nothing when no tab is left to reopen or the app is not loaded (loading or
/// error page).
#[cfg(target_os = "macos")]
fn reopen_closed_tab(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let target = win.clone();
    let _ = win.eval_with_callback(
        "window.__mdrReopenClosedTab ? window.__mdrReopenClosedTab() === true : false",
        move |result| {
            if result.trim() == "true" {
                let _ = target.show();
                let _ = target.set_focus();
            }
        },
    );
}

/// True once the main window has navigated away from the bundled loading
/// page. Bare activations (Dock click, plain `mdr`) must not clobber a doc
/// the user already has open, so they only navigate while this is false.
static NAVIGATED: AtomicBool = AtomicBool::new(false);
/// Serializes server discovery/startup so concurrent open events cannot
/// both conclude "no server" and spawn two of them.
static ENSURE_LOCK: Mutex<()> = Mutex::new(());
/// True from launch until the startup reconcile is over. Set before any open
/// can run, so an open never slips in ahead of the reconcile taking
/// ENSURE_LOCK.
static RECONCILING: AtomicBool = AtomicBool::new(true);
/// The port the window's UI is served from, once the shell has picked one
/// (0 until then). Only this loopback port loads inside the window.
static UI_PORT: AtomicU16 = AtomicU16::new(0);

/// Clears RECONCILING when the reconcile ends, on every return path.
struct ReconcileDone;

impl Drop for ReconcileDone {
    fn drop(&mut self) {
        RECONCILING.store(false, Ordering::SeqCst);
    }
}

/// Wait (bounded) for the startup reconcile, so opens use the server it
/// settles on.
fn wait_for_reconcile() {
    // Past the reconcile's own worst case (45s for the CLI, 20s to settle).
    let deadline = Instant::now() + Duration::from_secs(90);
    while RECONCILING.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

enum Target {
    File(String),
    Dir(String),
    /// A review-session id (opaque token, not a path). Emitted by the CLI's
    /// MCP flow so agent-triggered reviews focus the app instead of opening
    /// a browser tab. Never grants filesystem access: the MCP handler
    /// grants the session's file paths server-side before the link fires.
    Review(String),
}

impl Target {
    fn value(&self) -> &str {
        match self {
            Target::File(v) | Target::Dir(v) | Target::Review(v) => v,
        }
    }
}

/// Minimal HTTP/1.1 request over loopback. Returns (status, full response
/// text). Hand-rolled to keep the shell dependency-free; both endpoints we
/// talk to are mdr's own, on 127.0.0.1 only.
fn http_request(port: u16, method: &str, path: &str, json_body: Option<&str>) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    stream.set_write_timeout(Some(Duration::from_millis(1500))).ok()?;
    let body = json_body.unwrap_or("");
    let content_type = if json_body.is_some() { "Content-Type: application/json\r\n" } else { "" };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n{content_type}Content-Length: {}\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    Some((status, text))
}

/// The home this app serves: MD_REDLINE_HOME when set and not blank, else
/// $HOME. Mirrors bin/home-dir.js so the shell and the CLI agree on which
/// server is "ours".
fn own_home() -> Option<String> {
    std::env::var("MD_REDLINE_HOME")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("HOME").ok().filter(|h| !h.is_empty()))
}

/// Whether two spellings name the same directory, through realpath so a
/// symlinked spelling (/tmp vs /private/tmp) still matches. Same rule as the
/// CLI's sameDir.
fn same_dir(a: &str, b: &str) -> bool {
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
    canon(a) == canon(b)
}

/// The body of a raw HTTP response (everything after the blank line).
fn response_body(text: &str) -> &str {
    text.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("")
}

/// A response header's value, matched case-insensitively.
fn response_header<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let head = text.split_once("\r\n\r\n").map(|(head, _)| head).unwrap_or(text);
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// Whether an /api/config response is mdr's own config for `home`. Another
/// home is someone else's instance, most often the e2e suite's on 3101: it
/// writes the shared port file too, so without this the app adopted the test
/// server, whose home refuses the user's files and which shuts down under the
/// open window. Same check the CLI got in #217.
fn config_serves_home(body: &str, home: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("homeDir").and_then(|h| h.as_str()).map(|h| same_dir(h, home)))
        .unwrap_or(false)
}

/// Same probe as the CLI: /api/config must answer 200 with mdr's config
/// (a homeDir field, so another dev server's SPA fallback cannot fool us),
/// and that home must be ours.
fn check_server(port: u16) -> bool {
    let Some(home) = own_home() else { return false };
    matches!(http_request(port, "GET", "/api/config", None),
        Some((200, text)) if config_serves_home(response_body(&text), &home))
}

/// Vite dev client probe: the dev middleware answers "mdr" on /__mdr__ and
/// names the API port it proxies to in x-mdr-api-port. Only a client for
/// `api_port` counts, so another checkout's dev stack is never opened.
fn check_client(port: u16, api_port: u16) -> bool {
    matches!(http_request(port, "GET", "/__mdr__", None),
        Some((200, text)) if response_body(&text) == "mdr"
            && response_header(&text, "x-mdr-api-port") == Some(api_port.to_string().as_str()))
}

fn find_server_port() -> Option<u16> {
    // Port file fast path. Node's os.tmpdir() and Rust's env::temp_dir()
    // both resolve $TMPDIR, so this is the same file the CLI writes. Every
    // mdr server writes it, the e2e suite's included, so it is only a hint:
    // check_server still has to accept the port.
    if let Ok(saved) = std::fs::read_to_string(std::env::temp_dir().join("md-redline.port")) {
        if let Ok(port) = saved.trim().parse::<u16>() {
            if check_server(port) {
                return Some(port);
            }
        }
    }
    (DEFAULT_SERVER_PORT..DEFAULT_SERVER_PORT + MAX_PORT_SCAN).find(|&p| check_server(p))
}

fn find_client_port(api_port: u16) -> Option<u16> {
    (DEFAULT_CLIENT_PORT..DEFAULT_CLIENT_PORT + MAX_PORT_SCAN).find(|&p| check_client(p, api_port))
}

/// The port the UI should load right now: the dev client for our server when
/// one is running (dev mode), else the server itself. None when no server of
/// ours is up.
fn find_ui_port() -> Option<u16> {
    let server = find_server_port()?;
    Some(find_client_port(server).unwrap_or(server))
}

/// The user's shell, or /bin/zsh (macOS's default since Catalina) when
/// $SHELL is unset or not an absolute path.
fn user_shell(env_shell: Option<String>) -> String {
    env_shell
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

/// Where the shell appends what `mdr --no-open` prints. A Finder or Dock
/// launch has no terminal, so without this a failed start left no trace of
/// why. ~/Library/Logs is where macOS apps keep logs (Console.app lists it).
fn start_log_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(std::path::PathBuf::from(home).join("Library/Logs/mdr/server-start.log"))
}

/// Append one line to the start log. Best effort: logging never blocks a start.
fn log_start(line: &str) {
    let Some(path) = start_log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{secs}] {line}");
    }
}

/// Start the stack via the mdr CLI without opening anything. GUI apps
/// launch with a bare PATH, so go through the user's shell to find their
/// mdr install. It must be interactive as well as login (-lic): nvm's
/// installer and most zsh setups put PATH in ~/.zshrc, which a plain login
/// shell never reads, so `-lc` misses an nvm-linked mdr entirely. Same
/// trick editors use to recover a terminal PATH. Costs ~2s of rc startup,
/// well inside ensure_server_running's 30s budget. Output goes to the start
/// log (see start_log_path).
///
/// It runs from the user's home, as a terminal would. A Finder or Dock launch
/// leaves the app's cwd at `/`, and the server trusts the folder it starts in,
/// so inheriting that cwd would open the whole disk to it.
///
/// Returns the shell, which exits once `mdr --no-open` has a server up.
fn spawn_mdr_no_open(reason: &str) -> Option<Child> {
    let shell = user_shell(std::env::var("SHELL").ok());
    log_start(&format!("{reason}: {shell} -lic 'mdr --no-open'"));
    let log = start_log_path()
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok())
        .and_then(|out| out.try_clone().ok().map(|err| (out, err)));
    let (stdout, stderr) = match log {
        Some((out, err)) => (Stdio::from(out), Stdio::from(err)),
        None => (Stdio::null(), Stdio::null()),
    };
    let mut command = Command::new(&shell);
    command.args(["-lic", "mdr --no-open"]).stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    // The home as an absolute path: a relative MD_REDLINE_HOME would
    // otherwise be resolved again inside the new cwd.
    if let Some(home) = own_home().and_then(|h| std::path::absolute(h).ok()) {
        if home.is_dir() {
            if std::env::var_os("MD_REDLINE_HOME").is_some_and(|v| !v.is_empty()) {
                command.env("MD_REDLINE_HOME", &home);
            }
            command.current_dir(home);
        }
    }
    match command.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            log_start(&format!("could not run {shell}: {err}"));
            None
        }
    }
}

/// Wait up to `limit` for a spawned `mdr --no-open` shell to exit, which
/// reaps it. True when it exited in time.
fn wait_for_exit(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => return false,
        }
    }
    false
}

/// Whether the server at `port` serves the app page itself. A production
/// server (dist/server.js) does; a dev API server does not, and its page
/// comes from the Vite client instead.
fn serves_page(port: u16) -> bool {
    matches!(http_request(port, "GET", "/", None), Some((200, _)))
}

/// Once per app launch, delegate server-version reconciliation to the CLI:
/// `mdr --no-open` keeps a same-version server and gracefully swaps a stale
/// one left over from a previous install. The shell deliberately never
/// compares versions itself: a Rust-side check would strand a
/// not-yet-rebuilt shell after any npm version bump. Without this, a
/// Finder/Dock-only user could keep a stale server forever, since only CLI
/// invocations run the upgrade dance.
///
/// Opens wait for it (RECONCILING), so a Finder open at launch is neither
/// loaded from nor granted on a server that is about to be replaced.
fn reconcile_server_at_startup() {
    let _guard = ENSURE_LOCK.lock().unwrap();
    let _done = ReconcileDone;
    let Some(server) = find_server_port() else {
        return; // nothing of ours running; ensure_server_running will spawn
    };
    if find_client_port(server).is_some() {
        return; // dev mode serves live code; nothing to reconcile
    }
    // The CLI exits once the server it keeps or starts is up, so wait for
    // it rather than probing early, while the old server still answers.
    // A shell that never finishes (an rc file waiting on input, say) is
    // stopped rather than left to swap the server later, under opens that
    // went ahead without it.
    if let Some(mut child) = spawn_mdr_no_open("reconcile") {
        if !wait_for_exit(&mut child, Duration::from_secs(45)) {
            log_start("reconcile: mdr --no-open still running after 45s; stopped it");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // Then hold until the health check is steady: 3 consecutive successes
    // ~400ms apart, capped at 20s.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut stable = 0;
    while Instant::now() < deadline && stable < 3 {
        std::thread::sleep(Duration::from_millis(400));
        stable = if find_server_port().is_some() { stable + 1 } else { 0 };
    }
}

/// Returns the port the UI should load: Vite client in dev, server in prod.
/// Starts the stack via the mdr CLI when no server of ours is running.
fn ensure_server_running() -> Option<u16> {
    wait_for_reconcile();
    let _guard = ENSURE_LOCK.lock().unwrap();
    if let Some(port) = find_ui_port() {
        return Some(port);
    }

    if let Some(mut child) = spawn_mdr_no_open("no mdr server for this home") {
        // Reap the shell whenever it exits; the polling below decides when
        // the server is usable.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(server_port) = find_server_port() {
            if serves_page(server_port) {
                return Some(server_port);
            }
            // A dev API server: its Vite client follows shortly. Give it a
            // moment before falling back to the server port.
            let client_deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < client_deadline {
                if let Some(port) = find_client_port(server_port) {
                    return Some(port);
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            return Some(server_port);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    log_start("gave up: no mdr server for this home after 30s");
    None
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Ask the server to trust the target path, same as the CLI does before
/// opening. Matters for Finder "Open With" launches, which skip the CLI.
/// Refusals are logged to stderr (mirroring the CLI's warning); the SPA's
/// access-denied tab state remains the user-visible signal.
fn grant_access(path: &str) {
    if let Some(server_port) = find_server_port() {
        let body = format!("{{\"path\":{}}}", json_escape(path));
        match http_request(server_port, "POST", "/api/grant-access", Some(&body)) {
            Some((200, _)) => {}
            Some((status, _)) => {
                eprintln!("mdr: server refused access to {path} (HTTP {status}); it may open as access denied");
            }
            None => {
                eprintln!("mdr: could not reach the server to grant access to {path}");
            }
        }
    }
}

/// How an open reaches the main window. First contact always navigates off
/// the bundled loading page, and so does a window left on another origin (a
/// server that died, or one the shell should never have adopted); later opens
/// with a target are delivered in place via the SPA hook; bare activations
/// only bring the window forward.
#[derive(Debug, PartialEq, Eq)]
enum OpenAction {
    Navigate,
    OpenInPlace,
    FocusOnly,
}

fn open_action(first: bool, on_ui_origin: bool, has_target: bool) -> OpenAction {
    if first || !on_ui_origin {
        OpenAction::Navigate
    } else if has_target {
        OpenAction::OpenInPlace
    } else {
        OpenAction::FocusOnly
    }
}

/// Whether the window is showing the UI served on `ui_port`. A URL we cannot
/// read counts as yes, so an unknown state never clobbers an open document.
fn is_on_ui_origin(current: Option<&Url>, ui_port: u16) -> bool {
    let Some(url) = current else { return true };
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    loopback && url.port_or_known_default() == Some(ui_port)
}

/// JS handed to the running page for in-place opens. The SPA registers
/// window.__mdrOpenTarget while mounted; when it is absent (loading page,
/// error page, mid-reload) the script falls back to a full navigation.
fn build_open_script(target: &Option<Target>, url: &Url) -> String {
    let arg = match target {
        Some(Target::File(path)) => format!("{{file:{}}}", json_escape(path)),
        Some(Target::Dir(path)) => format!("{{dir:{}}}", json_escape(path)),
        Some(Target::Review(id)) => format!("{{review:{}}}", json_escape(id)),
        None => "{}".to_string(),
    };
    format!(
        "window.__mdrOpenTarget ? window.__mdrOpenTarget({arg}) : (window.location.href = {});",
        json_escape(url.as_str()),
    )
}

fn build_ui_url(ui_port: u16, target: &Option<Target>) -> Url {
    let mut url = Url::parse(&format!("http://127.0.0.1:{ui_port}/")).expect("loopback url");
    match target {
        Some(Target::File(path)) => {
            url.query_pairs_mut().append_pair("file", path);
        }
        Some(Target::Dir(path)) => {
            url.query_pairs_mut().append_pair("dir", path);
        }
        Some(Target::Review(id)) => {
            url.query_pairs_mut().append_pair("review", id);
        }
        None => {}
    }
    url
}

/// Whether the webview may navigate to `url` itself, or whether the shell
/// should hand it to the OS instead.
#[derive(Debug, PartialEq, Eq)]
enum NavDecision {
    /// In-app navigation (loopback http(s)) or an internal scheme
    /// (tauri://, about:blank) the webview must be allowed to load.
    Allow,
    /// A destination for the user's browser / mail client.
    External,
}

/// The app lives on 127.0.0.1, on the port the shell picked for its UI
/// (`ui_port`, 0 before it has picked one). Any other web link, including
/// another local service such as a dev server on localhost:3000, plus
/// mailto:/tel:, is external: loading it here would replace the app.
/// Everything else (tauri://, about:blank, and any other internal scheme,
/// plus Windows' http://tauri.localhost for the bundled loading page) stays
/// in the webview so the shell never blocks its own chrome.
fn classify_navigation(url: &Url, ui_port: u16) -> NavDecision {
    let host = url.host_str().unwrap_or("");
    let loopback = host == "127.0.0.1" || host == "localhost";
    let ours = ui_port != 0 && url.port_or_known_default() == Some(ui_port);
    match url.scheme() {
        "http" | "https" if loopback && ours => NavDecision::Allow,
        "http" | "https" if host == "tauri.localhost" => NavDecision::Allow,
        "http" | "https" | "mailto" | "tel" => NavDecision::External,
        _ => NavDecision::Allow,
    }
}

/// Open an external URL in the user's default handler. macOS `open` takes
/// the URL as a single argument (no shell), and callers only reach here for
/// http/https/mailto/tel, so there is no injection surface.
fn open_external(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

/// The single place the "main" window is created. Attaches the external-link
/// init script and the navigation handler that together route external
/// links to the system browser. `url` is the loading page (WebviewUrl::
/// default()) at startup, or the SPA URL when the window has to be rebuilt.
fn build_main_window(app: &AppHandle, url: WebviewUrl) -> Option<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, "main", url)
        .title("mdr")
        .inner_size(1360.0, 940.0)
        .min_inner_size(640.0, 480.0)
        .zoom_hotkeys_enabled(true)
        .initialization_script(EXTERNAL_LINK_SCRIPT);
    // Traffic lights centered on the 34px top row (sidebar switch, tabs)
    // at DEFAULT_ZOOM: (8 + 17) * 1.25 = 31pt down. Tao's y is the title bar
    // container's extra height, which moves the lights down 1:1 (y 19 put
    // their center at 17pt).
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 33.0))
        .initialization_script(SHELL_CHROME_SCRIPT.replace("__MDR_ZOOM__", &DEFAULT_ZOOM.to_string()));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.initialization_script(TAB_KEY_SCRIPT);
    builder
        .on_navigation(|url| match classify_navigation(url, UI_PORT.load(Ordering::SeqCst)) {
            NavDecision::Allow => true,
            NavDecision::External => {
                open_external(url.as_str());
                false
            }
        })
        .build()
        .ok()
}

/// Focus-or-open, the whole point of the shell. With a target: navigate the
/// window to that doc. Without one: bring the window forward, only
/// navigating if we are still on the bundled loading page.
///
/// `grant`: whether to auto-grant server access for the target. True only
/// for Finder file:// opens (a user gesture the CLI never sees). mdr://
/// deep links must NOT auto-grant: any web page can fire one, and granting
/// here would let it bypass restricted-mode consent. The CLI grants for
/// its own deep links before sending them, so legitimate opens still work;
/// anything else lands on the SPA's access-denied tab state.
fn open_target(app: &AppHandle, target: Option<Target>, grant: bool) {
    let Some(ui_port) = ensure_server_running() else {
        eprintln!("mdr: could not reach or start the mdr server");
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            // Mirror the success path: recreate the window if it is gone
            // (post-Reopen edge), so a failed server start is never fully
            // silent. The recreated window shows the bundled loading page;
            // the eval may race its load, hence the stderr line above as
            // the guaranteed signal.
            let win = app
                .get_webview_window("main")
                .or_else(|| build_main_window(&app, WebviewUrl::default()));
            if let Some(win) = win {
                // The .error styling only exists on the bundled loading
                // page; once the SPA is live it surfaces its own failures,
                // so the eval is gated to the pre-navigation state.
                if !NAVIGATED.load(Ordering::SeqCst) {
                    let _ = win.eval("document.body.classList.add('error')");
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
        });
        return;
    };

    if grant {
        match &target {
            Some(Target::File(path)) | Some(Target::Dir(path)) => grant_access(path),
            Some(Target::Review(_)) | None => {}
        }
    }

    // Before any navigation to it, so the navigation filter lets it through.
    UI_PORT.store(ui_port, Ordering::SeqCst);
    let url = build_ui_url(ui_port, &target);
    let has_target = target.is_some();
    let open_script = build_open_script(&target, &url);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("main") {
            // NAVIGATED decisions happen only here on the main thread, so a
            // bare activation racing a file open cannot clobber the doc.
            let first = !NAVIGATED.swap(true, Ordering::SeqCst);
            let current = win.url().ok();
            match open_action(first, is_on_ui_origin(current.as_ref(), ui_port), has_target) {
                OpenAction::Navigate => {
                    let _ = win.navigate(url);
                    let _ = win.set_zoom(DEFAULT_ZOOM);
                }
                // In-place open: the SPA adds a tab (or re-roots the
                // explorer) with no page reload, keeping existing tabs.
                OpenAction::OpenInPlace => {
                    let _ = win.eval(&open_script);
                }
                OpenAction::FocusOnly => {}
            }
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            NAVIGATED.store(true, Ordering::SeqCst);
            if let Some(win) = build_main_window(&app, WebviewUrl::External(url)) {
                let _ = win.set_zoom(DEFAULT_ZOOM);
            }
        }
    });
}

/// file:// URLs come from .md file associations, mdr://open?file=... from
/// the CLI deep link. Both funnel into open_target.
fn target_from_url(url: &Url) -> Option<Target> {
    if url.scheme() == "file" {
        let path = url.to_file_path().ok()?;
        let path_str = path.to_str()?.to_string();
        return Some(if path.is_dir() { Target::Dir(path_str) } else { Target::File(path_str) });
    }
    if url.scheme() == "mdr" {
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "file" => return Some(Target::File(value.into_owned())),
                "dir" => return Some(Target::Dir(value.into_owned())),
                "review" => return Some(Target::Review(value.into_owned())),
                _ => {}
            }
        }
        return None; // bare mdr://open: activate only
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_associations_are_md_only() {
        // The server only opens .md files, so the bundle must not claim any
        // other extension (a Finder open of one would fail).
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let assocs = conf["bundle"]["fileAssociations"].as_array().expect("file associations");
        assert_eq!(assocs.len(), 1);
        assert_eq!(assocs[0]["ext"], serde_json::json!(["md"]));
    }

    #[test]
    fn classify_navigation_keeps_the_app_in_and_sends_links_out() {
        let allow =
            |u: &str| classify_navigation(&Url::parse(u).unwrap(), 6373) == NavDecision::Allow;
        // In-app: the SPA and loading chrome.
        assert!(allow("http://127.0.0.1:6373/?file=%2Ftmp%2Fa.md"));
        assert!(allow("http://localhost:6373/"));
        assert!(allow("http://tauri.localhost/index.html"));
        assert!(allow("tauri://localhost/index.html"));
        assert!(allow("about:blank"));
        // External: hand off to the OS.
        assert!(!allow("https://example.com/docs"));
        assert!(!allow("http://example.com"));
        assert!(!allow("mailto:hello@dejuknow.com"));
        assert!(!allow("tel:+15551234567"));
        // Another local service is external too: it would replace the app.
        assert!(!allow("http://localhost:3000/"));
        assert!(!allow("http://127.0.0.1:8080/docs"));
        assert!(!allow("http://127.0.0.1/"));
        // Only the UI port the shell picked, not its whole scan range.
        assert!(!allow("http://127.0.0.1:6374/"));
        assert!(!allow("http://localhost:5188/"));
        // A server adopted from the port file on a custom port, or the dev
        // client, is allowed once it is the UI port.
        let on = |u: &str, port: u16| classify_navigation(&Url::parse(u).unwrap(), port);
        assert_eq!(on("http://127.0.0.1:7100/", 7100), NavDecision::Allow);
        assert_eq!(on("http://127.0.0.1:5188/?file=a.md", 5188), NavDecision::Allow);
        // Before a port is picked, no loopback page loads.
        assert_eq!(on("http://127.0.0.1:6373/", 0), NavDecision::External);
    }

    #[test]
    fn user_shell_prefers_absolute_shell_env_and_falls_back_to_zsh() {
        assert_eq!(user_shell(Some("/opt/homebrew/bin/bash".into())), "/opt/homebrew/bin/bash");
        assert_eq!(user_shell(None), "/bin/zsh");
        assert_eq!(user_shell(Some(String::new())), "/bin/zsh");
        assert_eq!(user_shell(Some("zsh".into())), "/bin/zsh");
    }

    #[test]
    fn open_action_covers_all_first_origin_target_combinations() {
        assert_eq!(open_action(true, true, true), OpenAction::Navigate);
        assert_eq!(open_action(true, true, false), OpenAction::Navigate);
        assert_eq!(open_action(false, true, true), OpenAction::OpenInPlace);
        assert_eq!(open_action(false, true, false), OpenAction::FocusOnly);
        // On a stale origin, even a bare activation re-points the window.
        assert_eq!(open_action(false, false, true), OpenAction::Navigate);
        assert_eq!(open_action(false, false, false), OpenAction::Navigate);
    }

    #[test]
    fn is_on_ui_origin_compares_loopback_port() {
        let url = |u: &str| Url::parse(u).unwrap();
        assert!(is_on_ui_origin(Some(&url("http://127.0.0.1:6373/?file=%2Fa.md")), 6373));
        assert!(is_on_ui_origin(Some(&url("http://localhost:5188/")), 5188));
        // The e2e server's origin, or a dead one, is not ours.
        assert!(!is_on_ui_origin(Some(&url("http://127.0.0.1:3101/")), 6373));
        assert!(!is_on_ui_origin(Some(&url("tauri://localhost/index.html")), 6373));
        assert!(!is_on_ui_origin(Some(&url("https://example.com/")), 443));
        // Unknown: leave the window alone.
        assert!(is_on_ui_origin(None, 6373));
    }

    #[test]
    fn config_serves_home_requires_our_home() {
        let home = std::env::temp_dir();
        let home = home.to_str().unwrap();
        let body = |h: &str| format!("{{\"initialFile\":\"\",\"homeDir\":{}}}", json_escape(h));
        assert!(config_serves_home(&body(home), home));
        // Another home (the e2e suite's) is someone else's instance.
        assert!(!config_serves_home(&body("/tmp/mdr-e2e-home-xyz"), home));
        // Not mdr's config at all.
        assert!(!config_serves_home("<!doctype html><title>other app</title>", home));
        assert!(!config_serves_home("{\"homeDir\":42}", home));
    }

    #[test]
    fn response_parsing_reads_body_and_headers() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Mdr-Api-Port: 6373\r\n\r\nmdr";
        assert_eq!(response_body(raw), "mdr");
        assert_eq!(response_header(raw, "x-mdr-api-port"), Some("6373"));
        assert_eq!(response_header(raw, "content-type"), Some("text/plain"));
        assert_eq!(response_header(raw, "x-missing"), None);
        assert_eq!(response_body("HTTP/1.1 200 OK"), "");
    }

    #[test]
    fn json_escape_quotes_backslashes_and_controls() {
        assert_eq!(json_escape(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(json_escape("tab\there"), r#""tab\there""#);
        assert_eq!(json_escape("\u{1}"), r#""\u0001""#);
    }

    #[test]
    fn build_ui_url_encodes_file_and_dir_params() {
        let url = build_ui_url(6373, &Some(Target::File("/tmp/my doc.md".into())));
        assert_eq!(url.as_str(), "http://127.0.0.1:6373/?file=%2Ftmp%2Fmy+doc.md");
        let url = build_ui_url(6373, &Some(Target::Dir("/tmp/dir".into())));
        assert_eq!(url.as_str(), "http://127.0.0.1:6373/?dir=%2Ftmp%2Fdir");
        let url = build_ui_url(6373, &Some(Target::Review("abc-123".into())));
        assert_eq!(url.as_str(), "http://127.0.0.1:6373/?review=abc-123");
        let url = build_ui_url(5188, &None);
        assert_eq!(url.as_str(), "http://127.0.0.1:5188/");
    }

    #[test]
    fn open_script_prefers_hook_and_falls_back_to_navigation() {
        let target = Some(Target::File("/tmp/a'b.md".into()));
        let url = build_ui_url(6373, &target);
        let script = build_open_script(&target, &url);
        // Path is JSON-escaped into the hook call; the fallback assigns the
        // full URL. No raw single quotes may survive JSON escaping that
        // would break the eval'd expression.
        assert!(script.starts_with("window.__mdrOpenTarget ? window.__mdrOpenTarget({file:\""));
        assert!(script.contains("window.location.href = \"http://127.0.0.1:6373/?file="));
    }

    #[test]
    fn target_from_url_parses_deep_links() {
        let url = Url::parse("mdr://open?file=%2Ftmp%2Fdoc.md").unwrap();
        match target_from_url(&url) {
            Some(Target::File(p)) => assert_eq!(p, "/tmp/doc.md"),
            other => panic!("expected file target, got {:?}", other.map(|t| t.value().to_string())),
        }
        let url = Url::parse("mdr://open?dir=%2Ftmp").unwrap();
        match target_from_url(&url) {
            Some(Target::Dir(p)) => assert_eq!(p, "/tmp"),
            other => panic!("expected dir target, got {:?}", other.map(|t| t.value().to_string())),
        }
        let url = Url::parse("mdr://open?review=abc-123").unwrap();
        match target_from_url(&url) {
            Some(Target::Review(id)) => assert_eq!(id, "abc-123"),
            other => panic!("expected review target, got {:?}", other.map(|t| t.value().to_string())),
        }
        // Bare activation: no target, the window is only focused.
        let url = Url::parse("mdr://open").unwrap();
        assert!(target_from_url(&url).is_none());
        let url = Url::parse("https://example.com/?file=%2Ftmp%2Fdoc.md").unwrap();
        assert!(target_from_url(&url).is_none());
    }

    #[test]
    fn target_from_url_classifies_file_urls_by_directory_check() {
        let dir = std::env::temp_dir();
        let url = Url::from_file_path(&dir).unwrap();
        assert!(matches!(target_from_url(&url), Some(Target::Dir(_))));
        let missing = dir.join("mdr-test-does-not-exist.md");
        let url = Url::from_file_path(&missing).unwrap();
        assert!(matches!(target_from_url(&url), Some(Target::File(_))));
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            // Show the loading window immediately (main thread) so launch
            // isn't a blank screen while the server is discovered; the
            // window carries the external-link handlers. Then reconcile the
            // server and navigate it to the SPA on a worker thread.
            build_main_window(&handle, WebviewUrl::default());
            // The menu goes in after the window. Set on the builder, before
            // any window existed, Reopen Closed Tab never showed: Shift-Cmd-T
            // is AppKit's Show Tab Bar shortcut, and automatic window tabbing
            // is only turned off when the first window is built.
            #[cfg(target_os = "macos")]
            app.set_menu(build_app_menu(&handle)?)?;
            std::thread::spawn(move || {
                reconcile_server_at_startup();
                open_target(&handle, None, false);
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            match event.id().as_ref() {
                MENU_CLOSE_TAB => close_tab_or_window(app),
                MENU_REOPEN_TAB => reopen_closed_tab(app),
                MENU_CLOSE_WINDOW => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        .on_window_event(|window, event| {
            // Mac convention: closing the window (Shift-Cmd-W, or Cmd-W
            // with no tab open) hides it, the app stays in the Dock, Cmd-Q
            // quits. Reopen (below) brings the window back. Windows and Linux
            // have no Dock to bring a hidden window back from, so there the
            // close goes through and closing the last window quits the app.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("failed to build mdr shell")
        .run(|app, event| match event {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            RunEvent::Opened { urls } => {
                // Multi-file Finder opens arrive as one batch here. Targets
                // that land before the SPA has registered its hook fall back
                // to full navigation inside build_open_script. On a cold
                // launch that reliably means the last file wins; on a warm
                // or mid-mount SPA the per-target hook check makes the
                // outcome race-dependent (some tabs in place, some full
                // navigations). Inherited limitation, roughly the pre-shell
                // browser behavior; revisit if multi-select opens matter.
                let app = app.clone();
                std::thread::spawn(move || {
                    for url in urls {
                        let grant = url.scheme() == "file";
                        let target = target_from_url(&url);
                        open_target(&app, target, grant);
                    }
                });
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    if !NAVIGATED.load(Ordering::SeqCst) {
                        let _ = win.eval("document.body.classList.remove('error')");
                    }
                    // Always re-ensure on Dock click: retries the server
                    // when we are stuck on the loading/error page, and
                    // revives one that died out from under a live SPA.
                    // No-op focus when everything is healthy.
                    let app = app.clone();
                    std::thread::spawn(move || open_target(&app, None, false));
                } else {
                    let app = app.clone();
                    std::thread::spawn(move || open_target(&app, None, false));
                }
            }
            _ => {}
        });
}
