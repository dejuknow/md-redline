// Desktop shell for md-redline. A thin client: discovers (or starts) the
// local mdr server and points a single webview window at it. All product
// logic lives in the web app; this binary only handles window lifecycle,
// the menus and keys browsers keep for themselves, page zoom, the mdr://
// deep link, .md file associations, files dropped on the window, and
// delivering the agent notifications the web app words (notify.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(target_os = "macos", test))]
mod notify;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU8;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

// Mirrors bin/cli.js: 6373 ("MDR" on a phone keypad) for the server,
// 5188 for the Vite dev client, +10 scan range, port file in tmpdir.
const DEFAULT_SERVER_PORT: u16 = 6373;
const DEFAULT_CLIENT_PORT: u16 = 5188;
const MAX_PORT_SCAN: u16 = 10;
/// The webview's zoom out of the box, and what View > Actual Size (Cmd+0)
/// returns to. The app's type and spacing are drawn for it.
const DEFAULT_ZOOM: f64 = 1.25;
/// The zoom levels Zoom In and Zoom Out step through.
const ZOOM_STEPS: [f64; 9] = [0.8, 0.9, 1.0, 1.1, DEFAULT_ZOOM, 1.4, 1.6, 1.8, 2.0];
/// The page zoom in effect, as f64 bits. The shell owns it: Tauri's own zoom
/// hotkeys are a page script that calls a webview command the loopback page
/// is not allowed, so before the View menu took over Cmd+= / Cmd+- / Cmd+0
/// did nothing. Saved to ZOOM_FILE on every change and read back at launch.
static ZOOM_BITS: AtomicU64 = AtomicU64::new(0);
static ZOOM_FILE: OnceLock<PathBuf> = OnceLock::new();

/// A zoom read back from disk, or anything else, as one of ZOOM_STEPS: the
/// nearest one, DEFAULT_ZOOM for anything unreadable.
fn snap_zoom(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return DEFAULT_ZOOM;
    }
    ZOOM_STEPS
        .iter()
        .copied()
        .min_by(|a, b| (a - value).abs().total_cmp(&(b - value).abs()))
        .unwrap_or(DEFAULT_ZOOM)
}

/// The zoom one step in (`dir` > 0) or out (`dir` < 0) from `current`,
/// staying at the ends of ZOOM_STEPS.
#[cfg(any(target_os = "macos", test))]
fn step_zoom(current: f64, dir: i32) -> f64 {
    let at = ZOOM_STEPS.iter().position(|z| *z == snap_zoom(current)).unwrap_or(4);
    let next = if dir > 0 { (at + 1).min(ZOOM_STEPS.len() - 1) } else if dir < 0 { at.saturating_sub(1) } else { at };
    ZOOM_STEPS[next]
}

fn parse_saved_zoom(text: &str) -> f64 {
    text.trim().parse::<f64>().map(snap_zoom).unwrap_or(DEFAULT_ZOOM)
}

fn current_zoom() -> f64 {
    let bits = ZOOM_BITS.load(Ordering::SeqCst);
    if bits == 0 { DEFAULT_ZOOM } else { f64::from_bits(bits) }
}

/// Reads the saved zoom (DEFAULT_ZOOM when there is none), once at launch.
fn load_zoom(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let file = dir.join("zoom");
    let zoom = std::fs::read_to_string(&file).map(|t| parse_saved_zoom(&t)).unwrap_or(DEFAULT_ZOOM);
    ZOOM_BITS.store(zoom.to_bits(), Ordering::SeqCst);
    let _ = ZOOM_FILE.set(file);
}

/// The script that brings the shell's window chrome in line with `zoom`
/// (see SHELL_CHROME_SCRIPT). Empty where there is no such chrome.
fn chrome_zoom_script(zoom: f64) -> String {
    if cfg!(target_os = "macos") {
        format!("window.__mdrShellZoom && window.__mdrShellZoom({zoom});")
    } else {
        String::new()
    }
}

/// Sets the page zoom and keeps the chrome's traffic-light room in step.
#[cfg(target_os = "macos")]
fn apply_zoom(win: &WebviewWindow, zoom: f64) {
    let _ = win.set_zoom(zoom);
    let script = chrome_zoom_script(zoom);
    if !script.is_empty() {
        let _ = win.eval(&script);
    }
}

/// View > Zoom In / Zoom Out (`dir` 1 / -1) and Actual Size (0).
#[cfg(target_os = "macos")]
fn change_zoom(app: &AppHandle, dir: i32) {
    let zoom = if dir == 0 { DEFAULT_ZOOM } else { step_zoom(current_zoom(), dir) };
    ZOOM_BITS.store(zoom.to_bits(), Ordering::SeqCst);
    if let Some(file) = ZOOM_FILE.get() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, zoom.to_string());
    }
    if let Some(win) = app.get_webview_window("main") {
        apply_zoom(&win, zoom);
    }
}

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
  // page is zoomed, so the room they need is kept in points and converted to
  // CSS px at the page zoom: the right edge of the lights plus a gap, and
  // their bottom plus a gap. WKWebView exposes no zoom to the page
  // (outerWidth / innerWidth stays 1), so the shell passes it: the zoom at
  // window build fills in __MDR_ZOOM__, and the shell calls __mdrShellZoom
  // again on every zoom change and every page load.
  //
  // The lights cannot move with the zoom either (Tauri sets their position
  // only when the window is built, and tao re-applies it on every redraw),
  // so the page frames itself around them (#253). Its gutter stays GUTTER_PT
  // at every zoom, like native window chrome, which keeps the lights the same
  // distance inside the panel's left edge. Its top gutter grows past that
  // when the 34px top rows can then center on the lights (zoomed out); zoomed
  // in, the rows are too tall to center there below a gutter, so the lights
  // sit in their upper half.
  var LIGHTS_RIGHT_PT = 98, LIGHTS_BOTTOM_PT = 43, LIGHTS_CENTER_PT = 31.25, GUTTER_PT = 10;
  window.__mdrShellZoom = function (Z) {
    if (!(Z > 0)) return;
    var px = function (v) { return v.toFixed(2) + 'px'; };
    var gutter = GUTTER_PT / Z;
    root.style.setProperty('--mdr-lights-r', px(LIGHTS_RIGHT_PT / Z));
    root.style.setProperty('--mdr-lights-b', px(LIGHTS_BOTTOM_PT / Z));
    root.style.setProperty('--mdr-gutter', px(gutter));
    root.style.setProperty('--mdr-gutter-top', px(Math.max(gutter, LIGHTS_CENTER_PT / Z - 17)));
  };
  window.__mdrShellZoom(__MDR_ZOOM__);
  var on = 'html[data-shell="mac"]:not([data-fullscreen]) ';
  var css = [
    // The page's gutter around its panels (see GUTTER_PT above).
    on + '[data-app-root] { --window-gutter: var(--mdr-gutter); --window-gutter-top: var(--mdr-gutter-top); }',
    // Sidebar open: its top row starts at the gutter and pads 4px past the inset.
    on + '[data-sidebar-top] { --window-inset-left: calc(var(--mdr-lights-r) - var(--mdr-gutter) - 4px); }',
    // Sidebar collapsed: the rail's icons drop below the lights (rail top at
    // the top gutter, plus its own 5px), and the tab strip (48px past the
    // gutter: the 40px rail and its 8px gap) clears them.
    on + '[data-sidebar-rail] { --window-inset-top: max(0px, calc(var(--mdr-lights-b) - var(--mdr-gutter-top) - 5px)); }',
    on + '[data-app-root]:has([data-sidebar-rail]) [data-doc-strip] { --window-inset-left: max(0px, calc(var(--mdr-lights-r) - var(--mdr-gutter) - 48px)); }',
    // No sidebar (focus mode): the tab strip starts at the gutter.
    on + '[data-app-root]:not(:has([data-sidebar-rail], [data-sidebar-panel])) [data-doc-strip] { --window-inset-left: calc(var(--mdr-lights-r) - var(--mdr-gutter)); }'
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

/// Tells the web app it runs inside the desktop app, on every platform and
/// before any of its scripts: it lists the desktop-only tab shortcuts in its
/// palette and shortcuts panel only then (`isDesktopApp` in
/// src/lib/desktop.ts), and its About section shows the app's own version,
/// which is not the npm package's. One flag, so nothing in the app sniffs
/// Tauri internals. `notifications` adds `__mdrDesktopNotifications`, which
/// shows the agent notifications setting: only where the shell can deliver
/// them (notify.rs).
fn desktop_flag_script(app_version: &str, notifications: bool) -> String {
    let mut script =
        format!("window.__mdrDesktop = true; window.__mdrDesktopVersion = {};", json_escape(app_version));
    if notifications {
        script.push_str(" window.__mdrDesktopNotifications = true;");
    }
    script
}

/// Whether this build can deliver notifications: macOS, from a `.app`
/// bundle.
fn notifications_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        *SUPPORTED.get_or_init(notify::mac::supported)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Whether the keep-alive policy is set on the current main webview (see
/// notify::mac::set_keep_alive). Reset when a window is built.
#[cfg(target_os = "macos")]
static KEEP_ALIVE: AtomicBool = AtomicBool::new(false);
/// The take call that is out and has not answered: its generation and when
/// it went. Takes never stack: a page WebKit has suspended answers nothing
/// until it resumes. A late answer to one given up on is still posted, but
/// does not free the slot of the take after it.
#[cfg(target_os = "macos")]
static TAKE_SENT: Mutex<Option<(u64, Instant)>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static TAKE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// A take that has not answered after this long is given up on.
#[cfg(target_os = "macos")]
const TAKE_STALE: Duration = Duration::from_secs(30);
/// How often the shell asks the page for notifications.
#[cfg(target_os = "macos")]
const TAKE_EVERY: Duration = Duration::from_secs(1);
/// How often, while notifications are on, the shell re-reads whether the
/// system allows them (the reader can change it in System Settings).
#[cfg(target_os = "macos")]
const PERMISSION_EVERY: Duration = Duration::from_secs(15);

/// Once a second, asks the page for the notifications that are ripe and posts
/// them (#244). The page decides what notifies and when; the shell only adds
/// whether its window has focus, so nothing is posted over a window the
/// reader is looking at.
#[cfg(target_os = "macos")]
fn start_notification_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_permission_check: Option<Instant> = None;
        let mut enabled_seen = false;
        loop {
            std::thread::sleep(TAKE_EVERY);
            let enabled = take_notifications(&app);
            if enabled.is_some() {
                let was = enabled_seen;
                enabled_seen = enabled == Some(true);
                if enabled_seen && !was {
                    notify::mac::allow_asking_again();
                }
            }
            if enabled_seen
                && last_permission_check.is_none_or(|at| at.elapsed() >= PERMISSION_EVERY)
            {
                last_permission_check = Some(Instant::now());
                // A long-lived thread has no autorelease pool of its own.
                objc2::rc::autoreleasepool(|_| notify::mac::refresh_permission(true));
            }
        }
    });
}

/// One take. Returns whether the setting was on as of the last answer that
/// arrived (None while none has).
#[cfg(target_os = "macos")]
fn take_notifications(app: &AppHandle) -> Option<bool> {
    static LAST_ENABLED: AtomicU8 = AtomicU8::new(0);
    let last = match LAST_ENABLED.load(Ordering::SeqCst) {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    };
    let win = app.get_webview_window("main")?;
    let generation;
    {
        let mut sent = TAKE_SENT.lock().unwrap();
        if sent.is_some_and(|(_, at)| at.elapsed() < TAKE_STALE) {
            return last;
        }
        generation = TAKE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *sent = Some((generation, Instant::now()));
    }
    let release = move || {
        let mut sent = TAKE_SENT.lock().unwrap();
        if sent.is_some_and(|(g, _)| g == generation) {
            *sent = None;
        }
    };
    let script = notify::take_script(reader_present(&win), notify::mac::permission());
    let target = win.clone();
    let asked = win.eval_with_callback(script, move |result| {
        release();
        // An answer to a take given up on, with a newer one already out: its
        // setting and focus are stale, so it changes nothing.
        if TAKE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let Some(take) = notify::parse_take(&result) else { return };
        LAST_ENABLED.store(if take.enabled { 1 } else { 2 }, Ordering::SeqCst);
        if KEEP_ALIVE.swap(take.enabled, Ordering::SeqCst) != take.enabled {
            let keep = take.enabled;
            let _ = target.with_webview(move |webview| unsafe {
                notify::mac::set_keep_alive(webview.inner(), keep);
            });
        }
        // The reader may have come back while the page answered.
        if take.items.is_empty() || reader_present(&target) {
            return;
        }
        for item in &take.items {
            notify::mac::post(item);
        }
    });
    if asked.is_err() {
        release();
    }
    last
}

/// The reader is looking at the window: shown, not minimized, focused.
#[cfg(target_os = "macos")]
fn reader_present(win: &WebviewWindow) -> bool {
    win.is_visible().unwrap_or(false)
        && !win.is_minimized().unwrap_or(false)
        && win.is_focused().unwrap_or(false)
}

/// Tab keys no app menu can carry: Ctrl+Tab everywhere (WKWebView never hands
/// it to the macOS menu), plus New Tab, Close Tab, Reopen Closed Tab and
/// Ctrl+1 to Ctrl+9 on Windows and Linux, which have no app menu. See the
/// script for the rules.
fn tab_key_script() -> String {
    include_str!("../scripts/tab-keys.js")
        .replace("__MDR_MENU_KEYS__", if cfg!(target_os = "macos") { "true" } else { "false" })
}

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

/// The macOS menu bar. Every item that acts on the document calls a hook core
/// registers (AGENTS.md, "Desktop shell hooks"); the shell only owns what
/// needs it: windows, zoom, and links out.
///
/// Keys, as measured in WKWebView: a menu accelerator fires only when the
/// page leaves the keydown unhandled (a page `preventDefault` suppresses it).
/// - Cmd+B, Cmd+Shift+O, Cmd+\, Cmd+. and Cmd+, are core's own keys. Core's
///   handler takes them everywhere (text fields, dialogs, the palette), so
///   they reach these items only while the Mermaid fullscreen view owns the
///   keyboard, where the hooks do nothing, as the key does. Their
///   accelerators therefore change nothing the keys did.
/// - Cmd+1 to Cmd+9, Cmd+=, Cmd+- and Cmd+0 are not core keys (Cmd+= / Cmd+-
///   / Cmd+0 zoom the diagram inside the Mermaid fullscreen view, which takes
///   them first), so the accelerators carry them.
/// - Ctrl+Tab never reaches the menu at all; the page key script
///   (scripts/tab-keys.js) reads it, and the Go menu only shows it.
/// - Single-letter keys (N, P, ?) never become accelerators: a menu key
///   fires inside text fields, where those letters are typing.
///
/// Built in `setup`, after the first window: set on the builder, Reopen
/// Closed Tab never showed, because Shift-Cmd-T is AppKit's Show Tab Bar
/// shortcut and automatic window tabbing is only turned off when the first
/// window is built.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let sep = || PredefinedMenuItem::separator(app);
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let tab_items = (1..=9)
        .map(|n| {
            let text = if n == 9 { "Last Tab".to_string() } else { format!("Tab {n}") };
            item(&format!("{MENU_SELECT_TAB_PREFIX}{n}"), &text, Some(&format!("CmdOrCtrl+{n}")))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mut go_items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    let prev_tab = item(MENU_PREV_TAB, "Previous Tab", Some("Ctrl+Shift+Tab"))?;
    let next_tab = item(MENU_NEXT_TAB, "Next Tab", Some("Ctrl+Tab"))?;
    let go_sep_1 = sep()?;
    let go_sep_2 = sep()?;
    let next_comment = item(MENU_NEXT_COMMENT, "Next Comment", None)?;
    let prev_comment = item(MENU_PREV_COMMENT, "Previous Comment", None)?;
    go_items.push(&prev_tab);
    go_items.push(&next_tab);
    go_items.push(&go_sep_1);
    for tab in &tab_items {
        go_items.push(tab);
    }
    go_items.push(&go_sep_2);
    go_items.push(&next_comment);
    go_items.push(&prev_comment);

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item(MENU_HELP_SHORTCUTS, "Keyboard Shortcuts", None)?,
            &sep()?,
            &item(MENU_HELP_GITHUB, "mdr on GitHub", None)?,
            &item(MENU_HELP_ISSUE, "Report an Issue", None)?,
            &item(MENU_HELP_RELEASES, "Release Notes", None)?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &item(MENU_ABOUT, &format!("About {}", app.package_info().name), None)?,
                    &sep()?,
                    &item(MENU_SETTINGS, "Settings\u{2026}", Some("CmdOrCtrl+Comma"))?,
                    &sep()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &item(MENU_NEW_TAB, "New Tab", Some("CmdOrCtrl+T"))?,
                    &item(MENU_CLOSE_TAB, "Close Tab", Some("CmdOrCtrl+W"))?,
                    &item(MENU_REOPEN_TAB, "Reopen Closed Tab", Some("CmdOrCtrl+Shift+T"))?,
                    &sep()?,
                    &item(MENU_REVEAL, "Show in Finder", None)?,
                    &sep()?,
                    &item(MENU_CLOSE_WINDOW, "Close Window", Some("CmdOrCtrl+Shift+W"))?,
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
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &item(MENU_TOGGLE_EXPLORER, "Toggle Explorer", Some("CmdOrCtrl+B"))?,
                    &item(MENU_TOGGLE_OUTLINE, "Toggle Outline", Some("CmdOrCtrl+Shift+O"))?,
                    &item(MENU_TOGGLE_COMMENTS, "Toggle Comments", Some("CmdOrCtrl+Backslash"))?,
                    &item(MENU_TOGGLE_FOCUS, "Toggle Focus Mode", Some("CmdOrCtrl+Period"))?,
                    &sep()?,
                    &item(MENU_ZOOM_RESET, "Actual Size", Some("CmdOrCtrl+0"))?,
                    &item(MENU_ZOOM_IN, "Zoom In", Some("CmdOrCtrl+Equal"))?,
                    &item(MENU_ZOOM_OUT, "Zoom Out", Some("CmdOrCtrl+Minus"))?,
                    &sep()?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "Go", true, &go_items)?,
            &window_menu,
            &help_menu,
        ],
    )?;
    // AppKit lists open windows in the Window menu and adds its search field
    // to the Help menu once they are marked as such.
    window_menu.set_as_windows_menu_for_nsapp()?;
    help_menu.set_as_help_menu_for_nsapp()?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
const GITHUB_URL: &str = "https://github.com/dejuknow/md-redline";

#[cfg(target_os = "macos")]
const MENU_ABOUT: &str = "about";
#[cfg(target_os = "macos")]
const MENU_NEW_TAB: &str = "new-tab";
#[cfg(target_os = "macos")]
const MENU_CLOSE_TAB: &str = "close-tab";
#[cfg(target_os = "macos")]
const MENU_REOPEN_TAB: &str = "reopen-tab";
#[cfg(target_os = "macos")]
const MENU_CLOSE_WINDOW: &str = "close-window";
#[cfg(target_os = "macos")]
const MENU_REVEAL: &str = "reveal";
#[cfg(target_os = "macos")]
const MENU_SETTINGS: &str = "settings";
#[cfg(target_os = "macos")]
const MENU_TOGGLE_EXPLORER: &str = "toggle-explorer";
#[cfg(target_os = "macos")]
const MENU_TOGGLE_OUTLINE: &str = "toggle-outline";
#[cfg(target_os = "macos")]
const MENU_TOGGLE_COMMENTS: &str = "toggle-comments";
#[cfg(target_os = "macos")]
const MENU_TOGGLE_FOCUS: &str = "toggle-focus";
#[cfg(target_os = "macos")]
const MENU_ZOOM_IN: &str = "zoom-in";
#[cfg(target_os = "macos")]
const MENU_ZOOM_OUT: &str = "zoom-out";
#[cfg(target_os = "macos")]
const MENU_ZOOM_RESET: &str = "zoom-reset";
#[cfg(target_os = "macos")]
const MENU_PREV_TAB: &str = "prev-tab";
#[cfg(target_os = "macos")]
const MENU_NEXT_TAB: &str = "next-tab";
#[cfg(target_os = "macos")]
const MENU_SELECT_TAB_PREFIX: &str = "select-tab-";
#[cfg(target_os = "macos")]
const MENU_NEXT_COMMENT: &str = "next-comment";
#[cfg(target_os = "macos")]
const MENU_PREV_COMMENT: &str = "prev-comment";
#[cfg(target_os = "macos")]
const MENU_HELP_SHORTCUTS: &str = "help-shortcuts";
#[cfg(target_os = "macos")]
const MENU_HELP_GITHUB: &str = "help-github";
#[cfg(target_os = "macos")]
const MENU_HELP_ISSUE: &str = "help-issue";
#[cfg(target_os = "macos")]
const MENU_HELP_RELEASES: &str = "help-releases";

/// What a menu item does, by id. Kept apart from the menu so it can be tested.
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    NewTab,
    CloseTab,
    ReopenTab,
    CloseWindow,
    About,
    Zoom(i32),
    /// Run a core hook (JS that evaluates to the hook's boolean result);
    /// `show` brings the window back first when it acted, for items whose
    /// result is something to look at (Settings, Keyboard Shortcuts).
    Hook { js: String, show: bool },
    Open(&'static str),
}

#[cfg(target_os = "macos")]
fn menu_action(id: &str) -> Option<MenuAction> {
    let hook = |js: &str, show: bool| Some(MenuAction::Hook { js: js.to_string(), show });
    match id {
        MENU_NEW_TAB => Some(MenuAction::NewTab),
        MENU_CLOSE_TAB => Some(MenuAction::CloseTab),
        MENU_REOPEN_TAB => Some(MenuAction::ReopenTab),
        MENU_CLOSE_WINDOW => Some(MenuAction::CloseWindow),
        MENU_ABOUT => Some(MenuAction::About),
        MENU_ZOOM_IN => Some(MenuAction::Zoom(1)),
        MENU_ZOOM_OUT => Some(MenuAction::Zoom(-1)),
        MENU_ZOOM_RESET => Some(MenuAction::Zoom(0)),
        MENU_SETTINGS => hook("__mdrOpenSettings()", true),
        MENU_HELP_SHORTCUTS => hook("__mdrShowShortcuts()", true),
        MENU_REVEAL => hook("__mdrRevealActiveFile()", false),
        MENU_TOGGLE_EXPLORER => hook("__mdrToggleExplorer()", false),
        MENU_TOGGLE_OUTLINE => hook("__mdrToggleOutline()", false),
        MENU_TOGGLE_COMMENTS => hook("__mdrToggleComments()", false),
        MENU_TOGGLE_FOCUS => hook("__mdrToggleFocusMode()", false),
        MENU_NEXT_TAB => hook("__mdrSwitchTab(1)", false),
        MENU_PREV_TAB => hook("__mdrSwitchTab(-1)", false),
        MENU_NEXT_COMMENT => hook("__mdrJumpToComment(1)", false),
        MENU_PREV_COMMENT => hook("__mdrJumpToComment(-1)", false),
        MENU_HELP_GITHUB => Some(MenuAction::Open(GITHUB_URL)),
        MENU_HELP_ISSUE => Some(MenuAction::Open("https://github.com/dejuknow/md-redline/issues/new/choose")),
        MENU_HELP_RELEASES => Some(MenuAction::Open("https://github.com/dejuknow/md-redline/releases")),
        _ => {
            let n: u8 = id.strip_prefix(MENU_SELECT_TAB_PREFIX)?.parse().ok()?;
            (1..=9).contains(&n).then(|| MenuAction::Hook { js: format!("__mdrSelectTab({n})"), show: false })
        }
    }
}

/// The eval'd form of a hook call: false when the app is not loaded (loading
/// or error page), where the hooks do not exist.
#[cfg(any(target_os = "macos", test))]
fn hook_call_script(call: &str) -> String {
    let name = call.split('(').next().unwrap_or(call);
    format!("window.{name} ? window.{call} === true : false")
}

/// Calls a core hook in the main window. With `show`, brings the window back
/// (Close Window hides it) when the hook acted; without it, does nothing
/// while the window is hidden, rather than switch tabs or toggle panes no one
/// can see.
#[cfg(target_os = "macos")]
fn call_hook(app: &AppHandle, call: &str, show: bool) {
    let Some(win) = app.get_webview_window("main") else { return };
    if !show && !win.is_visible().unwrap_or(true) {
        return;
    }
    let target = win.clone();
    let _ = win.eval_with_callback(hook_call_script(call), move |result| {
        if show && result.trim() == "true" {
            let _ = target.show();
            let _ = target.set_focus();
        }
    });
}

/// The standard About panel, filled in by hand rather than through
/// `PredefinedMenuItem::about`, for three things it cannot do:
/// - Our own icon. Left to itself the panel draws the system's copy of the
///   app icon, which on recent macOS comes back recolored (the document's
///   dark lines turn red), while Finder and the Dock draw it right.
/// - Styled credits. The predefined item passes them as plain text, which
///   the panel sets left-aligned in a larger font than every other line.
/// - No build number. An empty `Version` drops the "(0.6.0)" that would
///   otherwise repeat the version.
#[cfg(target_os = "macos")]
fn show_about_panel(app: &AppHandle) {
    use objc2::{rc::Retained, runtime::AnyObject, AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSImage,
        NSLinkAttributeName, NSMutableParagraphStyle, NSParagraphStyleAttributeName, NSTextAlignment,
    };
    use objc2_foundation::{
        NSAttributedString, NSData, NSDictionary, NSMutableAttributedString, NSRange, NSSize, NSString, NSURL,
    };

    let Some(mtm) = MainThreadMarker::new() else { return };
    let info = app.package_info();

    let data = NSData::with_bytes(include_bytes!("../icons/128x128@2x.png"));
    let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) else { return };
    // A 256 px image, drawn as a 2x one.
    icon.setSize(NSSize::new(128.0, 128.0));

    let tagline = "Review markdown with comments\u{2028}your AI agent can read.";
    let link = GITHUB_URL.trim_start_matches("https://");
    let text = format!("{tagline}\n{link}");
    let credits = NSMutableAttributedString::from_nsstring(&NSString::from_str(&text));
    let style = NSMutableParagraphStyle::new();
    style.setAlignment(NSTextAlignment::Center);
    style.setParagraphSpacing(6.0);
    let font = NSFont::systemFontOfSize(NSFont::smallSystemFontSize());
    let utf16_len = |s: &str| s.encode_utf16().count();
    let all = NSRange::new(0, utf16_len(&text));
    let link_range = NSRange::new(utf16_len(tagline) + 1, utf16_len(link));
    let Some(url) = NSURL::URLWithString(&NSString::from_str(GITHUB_URL)) else { return };
    unsafe {
        credits.addAttribute_value_range(NSFontAttributeName, &font, all);
        credits.addAttribute_value_range(NSParagraphStyleAttributeName, &style, all);
        credits.addAttribute_value_range(NSForegroundColorAttributeName, &NSColor::secondaryLabelColor(), all);
        credits.addAttribute_value_range(NSLinkAttributeName, &url, link_range);
    }
    let credits: Retained<NSAttributedString> = credits.into_super();

    let string = |s: &str| -> Retained<AnyObject> { NSString::from_str(s).into() };
    let keys = ["ApplicationIcon", "ApplicationName", "ApplicationVersion", "Version", "Credits", "Copyright"]
        .map(NSString::from_str);
    let values: [Retained<AnyObject>; 6] = [
        icon.into(),
        string(&info.name),
        string(&info.version.to_string()),
        string(""),
        credits.into(),
        string("\u{a9} 2026 Dennis Ju \u{b7} MIT License"),
    ];
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let options = NSDictionary::from_retained_objects(&key_refs, &values);
    unsafe { NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanelWithOptions(&options) };
}

#[cfg(target_os = "macos")]
fn handle_menu(app: &AppHandle, id: &str) {
    match menu_action(id) {
        Some(MenuAction::NewTab) => new_tab(app),
        Some(MenuAction::CloseTab) => close_tab_or_window(app),
        Some(MenuAction::ReopenTab) => reopen_closed_tab(app),
        Some(MenuAction::CloseWindow) => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
        }
        Some(MenuAction::About) => show_about_panel(app),
        Some(MenuAction::Zoom(dir)) => change_zoom(app, dir),
        Some(MenuAction::Hook { js, show }) => call_hook(app, &js, show),
        Some(MenuAction::Open(url)) => open_external(url),
        None => {}
    }
}

/// Asks the app for a new tab (it opens the file picker), bringing the window
/// back first if closing the last tab hid it, so the picker is seen. Does
/// nothing when the app is not loaded (loading or error page).
#[cfg(target_os = "macos")]
fn new_tab(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let target = win.clone();
    let _ = win.eval_with_callback(
        "window.__mdrNewTab ? (window.__mdrNewTab(), true) : false",
        move |result| {
            if result.trim() == "true" {
                let _ = target.show();
                let _ = target.set_focus();
            }
        },
    );
}

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
    /// Several files at once (a drop on the window), opened in order with the
    /// first one active.
    Files(Vec<String>),
    Dir(String),
    /// A file at one comment thread: a click on an agent notification
    /// (notify.rs). Never grants access: the file was already open.
    Thread(String, String),
    /// A review-session id (opaque token, not a path). Emitted by the CLI's
    /// MCP flow so agent-triggered reviews focus the app instead of opening
    /// a browser tab. Never grants filesystem access: the MCP handler
    /// grants the session's file paths server-side before the link fires.
    Review(String),
}

#[cfg(test)]
impl Target {
    fn value(&self) -> &str {
        match self {
            Target::File(v) | Target::Dir(v) | Target::Review(v) | Target::Thread(v, _) => v,
            Target::Files(v) => v.first().map(String::as_str).unwrap_or(""),
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

/// The login shell that runs `mdr --no-open`. It runs from the home folder
/// (set by the caller), which a server trusts as its start folder unless told
/// otherwise. The user never chose that folder, so trusting it would undo
/// restricted mode (`mdr --restrict`, #239); the env var tells the server not
/// to, and the CLI passes its environment on to the server it starts. The
/// home folder stays trusted when the user's trusted folders include it, as
/// they do by default.
fn mdr_no_open_command(shell: &str) -> Command {
    let mut command = Command::new(shell);
    command.args(["-lic", "mdr --no-open"]).env("MD_REDLINE_INTERNAL_NO_CWD_TRUST", "1");
    command
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
    let mut command = mdr_no_open_command(&shell);
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
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
/// window.__mdrOpenTarget once mounted, which can be a moment after the page
/// finishes loading, so the script waits for it (up to ~5s) before falling
/// back to a full navigation (an error page, or an SPA that never mounts).
/// It only ever runs in a loaded page: opens that arrive mid-load wait for
/// the load to finish (see PendingOpens).
fn build_open_script(target: &Option<Target>, url: &Url) -> String {
    let arg = match target {
        Some(Target::File(path)) => format!("{{file:{}}}", json_escape(path)),
        Some(Target::Files(paths)) => {
            let list: Vec<String> = paths.iter().map(|p| json_escape(p)).collect();
            format!("{{files:[{}]}}", list.join(","))
        }
        Some(Target::Dir(path)) => format!("{{dir:{}}}", json_escape(path)),
        Some(Target::Review(id)) => format!("{{review:{}}}", json_escape(id)),
        // A page older than the thread open ignores commentId and just
        // opens the file.
        Some(Target::Thread(path, comment)) => {
            format!("{{file:{},commentId:{}}}", json_escape(path), json_escape(comment))
        }
        None => "{}".to_string(),
    };
    format!(
        "(function (t, url, n) {{ (function go() {{ \
var h = window.__mdrOpenTarget; \
if (h && t.files && !h.acceptsFiles) t.files.forEach(function (f) {{ h({{file: f}}); }}); \
else if (h) h(t); \
else if (n-- > 0) setTimeout(go, 100); \
else window.location.href = url; }})(); }})({arg}, {}, 50);",
        json_escape(url.as_str()),
    )
}

/// In-place opens wait while the window is loading a page (a navigation the
/// shell started, or a reload), then run in order once it has loaded. Run
/// mid-load, an open was lost with the page it ran in: two files opened
/// from Finder at once, on a cold launch, opened only one.
struct PendingOpens {
    /// When the current load started; None once it finished.
    loading_since: Option<Instant>,
    /// The UI port of a navigation the shell started and that has not loaded
    /// yet. Until it has, the window's URL can still read as the page it is
    /// leaving (the loading page, on a cold launch), so opens decide by this
    /// instead: a second Finder file used to navigate again and replace the
    /// first.
    shell_nav: Option<u16>,
    scripts: Vec<String>,
}

/// A load that has not finished after this long is taken to have failed, so
/// later opens stop waiting for it.
const LOAD_WAIT: Duration = Duration::from_secs(15);

impl PendingOpens {
    const fn new() -> Self {
        PendingOpens { loading_since: None, shell_nav: None, scripts: Vec::new() }
    }

    /// A page started loading (a reload, a link, or a navigation below).
    fn load_started(&mut self, now: Instant) {
        self.loading_since = Some(now);
    }

    /// The shell is navigating the window to the UI on `port`.
    fn shell_navigation_started(&mut self, port: u16, now: Instant) {
        self.loading_since = Some(now);
        self.shell_nav = Some(port);
    }

    /// Whether a navigation the shell started to the UI on `port` is still
    /// loading (and not yet given up on).
    fn shell_navigating_to(&self, port: u16, now: Instant) -> bool {
        self.shell_nav == Some(port)
            && matches!(self.loading_since, Some(t) if now.duration_since(t) < LOAD_WAIT)
    }

    /// The scripts to run now that a page has loaded, in arrival order. A
    /// page other than the UI finishing (the loading page, slow to report)
    /// does not end a shell navigation to the UI: the held opens are for it.
    fn page_finished(&mut self, ui_page: bool) -> Vec<String> {
        if !ui_page && self.shell_nav.is_some() {
            return Vec::new();
        }
        self.loading_since = None;
        self.shell_nav = None;
        std::mem::take(&mut self.scripts)
    }

    /// The held scripts, once the load they wait for has run past
    /// LOAD_WAIT without finishing (a navigation that failed before it
    /// committed never reports Finished). None held, or still in time: none.
    fn take_if_stale(&mut self, now: Instant) -> Vec<String> {
        match self.loading_since {
            Some(t) if now.duration_since(t) >= LOAD_WAIT => {
                self.loading_since = None;
                self.shell_nav = None;
                std::mem::take(&mut self.scripts)
            }
            // Nothing loading: nothing to wait for.
            None => std::mem::take(&mut self.scripts),
            Some(_) => Vec::new(),
        }
    }

    /// The scripts to run now for a new open: none while a load is under
    /// way (it is kept for load_finished), else any left from a load that
    /// never finished, then this one.
    fn submit(&mut self, script: String, now: Instant) -> Vec<String> {
        if matches!(self.loading_since, Some(t) if now.duration_since(t) < LOAD_WAIT) {
            self.scripts.push(script);
            return Vec::new();
        }
        self.loading_since = None;
        self.shell_nav = None;
        let mut run = std::mem::take(&mut self.scripts);
        run.push(script);
        run
    }

    /// When the held opens run if the current load never finishes; None
    /// with nothing held.
    fn release_at(&self) -> Option<Instant> {
        if self.scripts.is_empty() {
            return None;
        }
        Some(self.loading_since.map(|t| t + LOAD_WAIT).unwrap_or_else(Instant::now))
    }
}

/// Whether a thread is already watching the held opens (see deliver_open).
static OPENS_WATCHED: AtomicBool = AtomicBool::new(false);

static PENDING_OPENS: Mutex<PendingOpens> = Mutex::new(PendingOpens::new());

/// Runs an in-place open now, or once the page loading in the window has
/// loaded.
fn deliver_open(win: &WebviewWindow, script: String) {
    let run = PENDING_OPENS.lock().unwrap().submit(script, Instant::now());
    if run.is_empty() && !OPENS_WATCHED.swap(true, Ordering::SeqCst) {
        // Held for the load. Should it never finish, run them anyway once
        // LOAD_WAIT is up: the script falls back to a full navigation when the
        // page has no hook, so an open is never silently dropped. One watcher,
        // kept up while anything is held, follows the current load's deadline
        // (a newer load restarts it).
        let win = win.clone();
        std::thread::spawn(move || loop {
            let Some(at) = PENDING_OPENS.lock().unwrap().release_at() else {
                OPENS_WATCHED.store(false, Ordering::SeqCst);
                // Something held since the check above gets a new watcher.
                if PENDING_OPENS.lock().unwrap().release_at().is_none()
                    || OPENS_WATCHED.swap(true, Ordering::SeqCst)
                {
                    return;
                }
                continue;
            };
            std::thread::sleep(at.saturating_duration_since(Instant::now()) + Duration::from_millis(100));
            let run = PENDING_OPENS.lock().unwrap().take_if_stale(Instant::now());
            for script in run {
                let _ = win.eval(&script);
            }
        });
    }
    for script in run {
        let _ = win.eval(&script);
    }
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
        // Only the fallback for a page whose SPA never mounts: the file,
        // without the thread.
        Some(Target::Thread(path, _)) => {
            url.query_pairs_mut().append_pair("file", path);
        }
        // Only the fallback for a page whose SPA never mounts; the files
        // themselves go through the open hook.
        Some(Target::Files(paths)) => {
            if let Some(first) = paths.first() {
                url.query_pairs_mut().append_pair("file", first);
            }
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
    let zoom = current_zoom();
    // Built hidden: the window-state plugin moves and sizes it to where it
    // was last (in its window-ready hook, during build), keep_on_screen
    // checks the result, and only then is it shown, so it never jumps.
    let builder = WebviewWindowBuilder::new(app, "main", url)
        .title("mdr")
        .inner_size(1360.0, 940.0)
        .min_inner_size(640.0, 480.0)
        .visible(false)
        .initialization_script(desktop_flag_script(
            &app.package_info().version.to_string(),
            notifications_supported(),
        ))
        .initialization_script(EXTERNAL_LINK_SCRIPT)
        .initialization_script(tab_key_script());
    // WebView2 zooms on Ctrl+= / Ctrl+- / Ctrl+0 by itself. Elsewhere Tauri's
    // zoom hotkeys are a page script calling a webview command the loopback
    // page is not allowed, so they did nothing; macOS zooms from the View menu.
    #[cfg(target_os = "windows")]
    let builder = builder.zoom_hotkeys_enabled(true);
    // Traffic lights centered on the 34px top row (sidebar switch, tabs)
    // at DEFAULT_ZOOM: (8 + 17) * 1.25 = 31pt down. Tao's y is the title bar
    // container's extra height, which moves the lights down 1:1 (y 19 put
    // their center at 17pt).
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 33.0))
        .initialization_script(SHELL_CHROME_SCRIPT.replace("__MDR_ZOOM__", &zoom.to_string()));
    let win = builder
        .on_navigation(|url| match classify_navigation(url, UI_PORT.load(Ordering::SeqCst)) {
            NavDecision::Allow => true,
            NavDecision::External => {
                open_external(url.as_str());
                false
            }
        })
        .on_page_load(|win, payload| match payload.event() {
            PageLoadEvent::Started => PENDING_OPENS.lock().unwrap().load_started(Instant::now()),
            PageLoadEvent::Finished => {
                // The chrome script ran with the zoom the window was built
                // at; a reload since a zoom change needs the current one.
                let script = chrome_zoom_script(current_zoom());
                if !script.is_empty() {
                    let _ = win.eval(&script);
                }
                let ui = is_on_ui_origin(Some(payload.url()), UI_PORT.load(Ordering::SeqCst));
                let run = PENDING_OPENS.lock().unwrap().page_finished(ui);
                for script in run {
                    let _ = win.eval(&script);
                }
            }
        })
        .build()
        .ok()?;
    let _ = win.set_zoom(zoom);
    // A new webview starts with WebKit's default (suspend when hidden); the
    // next take sets the policy again if notifications are on.
    #[cfg(target_os = "macos")]
    KEEP_ALIVE.store(false, Ordering::SeqCst);
    place_and_show(&win);
    Some(win)
}

/// Shows the window once the window-state plugin's restore has landed and
/// keep_on_screen has checked it. On macOS the plugin's moves and resizes are
/// queued on the main queue, so reading the frame right after build reads the
/// one it had before; this waits a moment and checks the restored one.
fn place_and_show(win: &WebviewWindow) {
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        let w = win.clone();
        let _ = win.run_on_main_thread(move || {
            if keep_on_screen(&w) {
                // Let the correction land before the window shows.
                let w2 = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    let w3 = w2.clone();
                    let _ = w2.run_on_main_thread(move || {
                        let _ = w3.show();
                    });
                });
            } else {
                let _ = w.show();
            }
        });
    });
}

/// A rectangle in physical pixels: a window's outer frame or a monitor's
/// work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

/// Where a restored window should go instead, or None when it can be reached
/// where it is. Reachable means some screen shows at least 100px of its top
/// strip (the title bar, where it is dragged from); the window-state plugin
/// only checks that a corner is on some monitor, so a window saved mostly
/// off a screen that is now smaller, or on one since unplugged, could come
/// back out of reach. Such a window is fitted to the first screen (the main
/// one) and centered on it.
fn fix_placement(win: Rect, screens: &[Rect]) -> Option<Rect> {
    const STRIP: i64 = 40;
    const MIN_VISIBLE: i64 = 100;
    let (x, y, w) = (win.x as i64, win.y as i64, win.w as i64);
    let strip_bottom = y + STRIP.min(win.h as i64);
    let reachable = screens.iter().any(|s| {
        let (sx, sy) = (s.x as i64, s.y as i64);
        let overlap_x = (x + w).min(sx + s.w as i64) - x.max(sx);
        let overlap_y = strip_bottom.min(sy + s.h as i64) - y.max(sy);
        overlap_x >= MIN_VISIBLE && overlap_y > 0
    });
    if reachable {
        return None;
    }
    let screen = screens.first()?;
    let (fw, fh) = (win.w.min(screen.w), win.h.min(screen.h));
    Some(Rect {
        x: screen.x + ((screen.w - fw) / 2) as i32,
        y: screen.y + ((screen.h - fh) / 2) as i32,
        w: fw,
        h: fh,
    })
}

/// Brings a window restored out of reach back onto the main screen. True
/// when it moved it.
fn keep_on_screen(win: &WebviewWindow) -> bool {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return false };
    let Ok(monitors) = win.available_monitors() else { return false };
    let primary = win.primary_monitor().ok().flatten();
    let area = |m: &tauri::Monitor| {
        let a = m.work_area();
        Rect { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height }
    };
    // The main screen first: it is where an unreachable window goes.
    let mut screens: Vec<Rect> = primary.as_ref().map(area).into_iter().collect();
    screens.extend(monitors.iter().map(area).filter(|r| Some(*r) != primary.as_ref().map(area)));
    let current = Rect { x: pos.x, y: pos.y, w: size.width, h: size.height };
    match fix_placement(current, &screens) {
        Some(fixed) => {
            let _ = win.set_size(tauri::PhysicalSize::new(fixed.w, fixed.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(fixed.x, fixed.y));
            true
        }
        None => false,
    }
}

/// What a drop of `paths` on the window opens: every .md file, in the order
/// dropped (the first one active), or with none, the first folder, shown in
/// the explorer as `mdr <dir>` shows it. Anything else (an image, a .txt) is
/// ignored, as the server would refuse it; so is a drop with nothing to open.
fn drop_target(paths: &[PathBuf]) -> Option<Target> {
    let is_md = |p: &Path| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"));
    let files: Vec<String> = paths
        .iter()
        .filter(|p| p.is_file() && is_md(p))
        .filter_map(|p| p.to_str().map(str::to_string))
        .collect();
    if !files.is_empty() {
        return Some(Target::Files(files));
    }
    paths
        .iter()
        .find(|p| p.is_dir())
        .and_then(|p| p.to_str())
        .map(|p| Target::Dir(p.to_string()))
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
            Some(Target::Files(paths)) => paths.iter().for_each(|path| grant_access(path)),
            Some(Target::Review(_)) | Some(Target::Thread(..)) | None => {}
        }
    }

    // Before any navigation to it, so the navigation filter lets it through.
    UI_PORT.store(ui_port, Ordering::SeqCst);
    let url = build_ui_url(ui_port, &target);
    let has_target = target.is_some();
    let open_script = build_open_script(&target, &url);
    // Several files open through the hook even when the window has to load
    // the app first: a URL carries only one.
    // So does a notification's thread: a cold launch would otherwise load
    // `?file=` and lose which thread to open.
    let multi = matches!(target, Some(Target::Files(_)) | Some(Target::Thread(..)));
    let root_url = build_ui_url(ui_port, &None);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("main") {
            // NAVIGATED decisions happen only here on the main thread, so a
            // bare activation racing a file open cannot clobber the doc.
            let first = !NAVIGATED.swap(true, Ordering::SeqCst);
            let current = win.url().ok();
            // Already on its way to the UI: the URL may still read as the
            // page it is leaving.
            let on_ui = PENDING_OPENS.lock().unwrap().shell_navigating_to(ui_port, Instant::now())
                || is_on_ui_origin(current.as_ref(), ui_port);
            match open_action(first, on_ui, has_target) {
                OpenAction::Navigate => {
                    PENDING_OPENS.lock().unwrap().shell_navigation_started(ui_port, Instant::now());
                    if multi {
                        let _ = win.navigate(root_url);
                        deliver_open(&win, open_script);
                    } else {
                        let _ = win.navigate(url);
                    }
                    let _ = win.set_zoom(current_zoom());
                }
                // In-place open: the SPA adds a tab (or re-roots the
                // explorer) with no page reload, keeping existing tabs.
                OpenAction::OpenInPlace => deliver_open(&win, open_script),
                OpenAction::FocusOnly => {}
            }
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            NAVIGATED.store(true, Ordering::SeqCst);
            PENDING_OPENS.lock().unwrap().shell_navigation_started(ui_port, Instant::now());
            if multi {
                if let Some(win) = build_main_window(&app, WebviewUrl::External(root_url)) {
                    deliver_open(&win, open_script);
                }
            } else {
                build_main_window(&app, WebviewUrl::External(url));
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
    fn mdr_no_open_command_tells_the_server_not_to_trust_its_start_folder() {
        let command = mdr_no_open_command("/bin/zsh");
        assert_eq!(command.get_program(), "/bin/zsh");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-lic", "mdr --no-open"]);
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(
            std::ffi::OsStr::new("MD_REDLINE_INTERNAL_NO_CWD_TRUST"),
            Some(std::ffi::OsStr::new("1"))
        )));
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
        // Path is JSON-escaped into the hook's argument; the fallback
        // assigns the full URL once the hook never shows up. No raw single
        // quotes may survive JSON escaping that would break the eval'd
        // expression.
        assert!(script.contains("var h = window.__mdrOpenTarget;"));
        assert!(script.contains("else if (h) h(t);"));
        assert!(script.contains("setTimeout(go, 100)"));
        assert!(script.contains("})({file:\"/tmp/a'b.md\"}, \"http://127.0.0.1:6373/?file="));
        assert!(script.ends_with(", 50);"));
    }

    #[test]
    fn open_script_passes_dropped_files_in_order() {
        let target = Some(Target::Files(vec!["/tmp/b.md".into(), "/tmp/a \"q\".md".into()]));
        let url = build_ui_url(6373, &target);
        // The fallback URL can only carry the first file.
        assert_eq!(url.as_str(), "http://127.0.0.1:6373/?file=%2Ftmp%2Fb.md");
        let script = build_open_script(&target, &url);
        assert!(script.contains(r#"({files:["/tmp/b.md","/tmp/a \"q\".md"]}, "#));
        // A page older than the shell opens them one file at a time.
        assert!(script.contains("t.files && !h.acceptsFiles"));
    }

    #[test]
    fn zoom_steps_through_the_ladder_and_stops_at_its_ends() {
        assert_eq!(step_zoom(DEFAULT_ZOOM, 1), 1.4);
        assert_eq!(step_zoom(DEFAULT_ZOOM, -1), 1.1);
        assert_eq!(step_zoom(2.0, 1), 2.0);
        assert_eq!(step_zoom(0.8, -1), 0.8);
        assert_eq!(step_zoom(1.0, 0), 1.0);
        // Off the ladder: from the nearest step.
        assert_eq!(step_zoom(1.27, 1), 1.4);
        assert_eq!(ZOOM_STEPS.iter().filter(|z| **z == DEFAULT_ZOOM).count(), 1);
    }

    #[test]
    fn saved_zoom_snaps_to_the_ladder_and_falls_back_to_the_default() {
        assert_eq!(parse_saved_zoom("1.6\n"), 1.6);
        assert_eq!(parse_saved_zoom("1.62"), 1.6);
        assert_eq!(parse_saved_zoom("9"), 2.0);
        assert_eq!(parse_saved_zoom("0.1"), 0.8);
        assert_eq!(parse_saved_zoom(""), DEFAULT_ZOOM);
        assert_eq!(parse_saved_zoom("big"), DEFAULT_ZOOM);
        assert_eq!(parse_saved_zoom("NaN"), DEFAULT_ZOOM);
        assert_eq!(parse_saved_zoom("-1"), DEFAULT_ZOOM);
    }

    #[test]
    fn pending_opens_wait_for_the_load_and_run_in_order() {
        let t0 = Instant::now();
        let mut p = PendingOpens::new();
        // Nothing loading: an open runs at once.
        assert_eq!(p.submit("a".into(), t0), vec!["a".to_string()]);
        // Mid-load: held, then run in arrival order when the page loads.
        p.load_started(t0);
        assert!(p.submit("b".into(), t0).is_empty());
        assert!(p.submit("c".into(), t0 + Duration::from_secs(1)).is_empty());
        assert_eq!(p.page_finished(true), vec!["b".to_string(), "c".to_string()]);
        assert_eq!(p.submit("d".into(), t0), vec!["d".to_string()]);
    }

    #[test]
    fn pending_opens_stop_waiting_for_a_load_that_never_finishes() {
        let t0 = Instant::now();
        let mut p = PendingOpens::new();
        p.load_started(t0);
        assert!(p.submit("a".into(), t0).is_empty());
        // Past LOAD_WAIT the held open runs first, then the new one.
        let later = t0 + LOAD_WAIT + Duration::from_millis(1);
        assert_eq!(p.submit("b".into(), later), vec!["a".to_string(), "b".to_string()]);
        assert!(p.page_finished(true).is_empty());
    }

    #[test]
    fn a_shell_navigation_counts_as_the_ui_until_it_loads() {
        let t0 = Instant::now();
        let mut p = PendingOpens::new();
        assert!(!p.shell_navigating_to(6373, t0));
        p.shell_navigation_started(6373, t0);
        assert!(p.shell_navigating_to(6373, t0 + Duration::from_secs(2)));
        assert!(!p.shell_navigating_to(6374, t0));
        assert!(!p.shell_navigating_to(6373, t0 + LOAD_WAIT));
        // A second open is held, not navigated.
        assert!(p.submit("b".into(), t0).is_empty());
        assert_eq!(p.release_at(), Some(t0 + LOAD_WAIT));
        // The loading page reporting late does not end it.
        assert!(p.page_finished(false).is_empty());
        assert!(p.shell_navigating_to(6373, t0));
        // The UI loading does, and runs what waited.
        assert_eq!(p.page_finished(true), vec!["b".to_string()]);
        assert!(!p.shell_navigating_to(6373, t0));
        assert_eq!(p.release_at(), None);
        // With no shell navigation, any page finishing releases opens.
        p.load_started(t0);
        assert!(p.submit("c".into(), t0).is_empty());
        assert_eq!(p.page_finished(false), vec!["c".to_string()]);
    }

    #[test]
    fn pending_opens_are_released_once_the_load_is_stale() {
        let t0 = Instant::now();
        let mut p = PendingOpens::new();
        p.load_started(t0);
        assert!(p.submit("a".into(), t0).is_empty());
        // Still in time: kept for the load.
        assert!(p.take_if_stale(t0 + Duration::from_secs(1)).is_empty());
        // Past LOAD_WAIT: released, and the next open runs at once.
        assert_eq!(p.take_if_stale(t0 + LOAD_WAIT), vec!["a".to_string()]);
        assert!(p.take_if_stale(t0 + LOAD_WAIT * 2).is_empty());
        assert_eq!(p.submit("b".into(), t0 + LOAD_WAIT), vec!["b".to_string()]);
        // Nothing loading: nothing to release.
        assert!(PendingOpens::new().take_if_stale(t0).is_empty());
    }

    #[test]
    fn fix_placement_keeps_reachable_windows_and_recenters_lost_ones() {
        let main = Rect { x: 0, y: 25, w: 1512, h: 920 };
        let external = Rect { x: 1512, y: -300, w: 2560, h: 1415 };
        let win = |x, y, w, h| Rect { x, y, w, h };
        // On a screen, or partly off one with its title bar in reach: kept.
        assert_eq!(fix_placement(win(100, 100, 1360, 800), &[main]), None);
        assert_eq!(fix_placement(win(1300, 100, 1360, 800), &[main]), None);
        assert_eq!(fix_placement(win(2000, 0, 1360, 940), &[main, external]), None);
        // Saved on a monitor since unplugged: centered on the main screen.
        assert_eq!(
            fix_placement(win(2000, 0, 1360, 940), &[main]),
            Some(win(76, 25, 1360, 920))
        );
        // Only a sliver (a corner) on screen: out of reach, so moved.
        assert_eq!(
            fix_placement(win(1450, 200, 1000, 600), &[main]),
            Some(win(256, 185, 1000, 600))
        );
        // Title bar above the screen's top: moved.
        assert!(fix_placement(win(100, -500, 1000, 600), &[main]).is_some());
        // Bigger than the screen it lands on: fitted to it.
        assert_eq!(
            fix_placement(win(-5000, 0, 3000, 2000), &[main]),
            Some(win(0, 25, 1512, 920))
        );
        // No screens known: left alone.
        assert_eq!(fix_placement(win(-5000, 0, 100, 100), &[]), None);
    }

    #[test]
    fn drop_target_opens_md_files_in_order_or_else_a_folder() {
        let dir = std::env::temp_dir().join(format!("mdr-drop-test-{}", std::process::id()));
        let sub = dir.join("notes");
        std::fs::create_dir_all(&sub).unwrap();
        let b = dir.join("b.md");
        let a = dir.join("A.MD");
        let txt = dir.join("c.txt");
        let markdown = dir.join("d.markdown");
        for f in [&b, &a, &txt, &markdown] {
            std::fs::write(f, "# x\n").unwrap();
        }
        let s = |p: &PathBuf| p.to_str().unwrap().to_string();
        // Files win over folders, keep the drop's order, and only .md opens.
        match drop_target(&[sub.clone(), b.clone(), txt.clone(), a.clone(), markdown.clone()]) {
            Some(Target::Files(files)) => assert_eq!(files, vec![s(&b), s(&a)]),
            _ => panic!("expected the .md files"),
        }
        // No .md file: the first folder is shown.
        match drop_target(&[txt.clone(), sub.clone(), dir.clone()]) {
            Some(Target::Dir(d)) => assert_eq!(d, s(&sub)),
            _ => panic!("expected the folder"),
        }
        // Nothing to open: ignored. A missing path is not a file.
        assert!(drop_target(&[txt.clone(), markdown.clone()]).is_none());
        assert!(drop_target(&[dir.join("gone.md")]).is_none());
        assert!(drop_target(&[]).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hook_calls_are_guarded_for_pages_without_the_hooks() {
        assert_eq!(
            hook_call_script("__mdrSelectTab(3)"),
            "window.__mdrSelectTab ? window.__mdrSelectTab(3) === true : false"
        );
    }

    #[test]
    fn desktop_flag_script_sets_the_flag_and_the_app_version() {
        assert_eq!(
            desktop_flag_script("0.6.0", false),
            r#"window.__mdrDesktop = true; window.__mdrDesktopVersion = "0.6.0";"#
        );
    }

    #[test]
    fn desktop_flag_script_adds_the_notifications_flag_only_where_supported() {
        assert!(desktop_flag_script("0.6.0", true).ends_with(" window.__mdrDesktopNotifications = true;"));
        assert!(!desktop_flag_script("0.6.0", false).contains("Notifications"));
    }

    #[test]
    fn a_notification_click_opens_the_thread_and_falls_back_to_the_file() {
        let target = Some(Target::Thread("/tmp/a.md".into(), "c1".into()));
        let url = build_ui_url(6373, &target);
        assert_eq!(url.as_str(), "http://127.0.0.1:6373/?file=%2Ftmp%2Fa.md");
        let script = build_open_script(&target, &url);
        assert!(script.contains("})({file:\"/tmp/a.md\",commentId:\"c1\"}, \"http://127.0.0.1:6373/?file="));
    }

    #[test]
    fn tab_key_script_knows_which_keys_the_menus_carry() {
        let script = tab_key_script();
        assert!(!script.contains("__MDR_MENU_KEYS__"));
        let expected = if cfg!(target_os = "macos") { "MENU_KEYS = true;" } else { "MENU_KEYS = false;" };
        assert!(script.contains(expected));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn menu_items_map_to_their_actions() {
        let hook = |js: &str, show: bool| Some(MenuAction::Hook { js: js.into(), show });
        assert_eq!(menu_action(MENU_ZOOM_RESET), Some(MenuAction::Zoom(0)));
        assert_eq!(menu_action(MENU_ZOOM_IN), Some(MenuAction::Zoom(1)));
        assert_eq!(menu_action(MENU_ZOOM_OUT), Some(MenuAction::Zoom(-1)));
        assert_eq!(menu_action(MENU_SETTINGS), hook("__mdrOpenSettings()", true));
        assert_eq!(menu_action(MENU_HELP_SHORTCUTS), hook("__mdrShowShortcuts()", true));
        assert_eq!(menu_action(MENU_TOGGLE_EXPLORER), hook("__mdrToggleExplorer()", false));
        assert_eq!(menu_action(MENU_NEXT_TAB), hook("__mdrSwitchTab(1)", false));
        assert_eq!(menu_action("select-tab-1"), hook("__mdrSelectTab(1)", false));
        assert_eq!(menu_action("select-tab-9"), hook("__mdrSelectTab(9)", false));
        assert_eq!(menu_action("select-tab-0"), None);
        assert_eq!(menu_action("select-tab-10"), None);
        assert_eq!(menu_action("select-tab-x"), None);
        assert_eq!(menu_action(MENU_HELP_GITHUB), Some(MenuAction::Open(GITHUB_URL)));
        // Help links stay on GitHub over https, the only place they go.
        for id in [MENU_HELP_GITHUB, MENU_HELP_ISSUE, MENU_HELP_RELEASES] {
            match menu_action(id) {
                Some(MenuAction::Open(url)) => {
                    assert!(url.starts_with("https://github.com/dejuknow/md-redline"))
                }
                other => panic!("{id}: {other:?}"),
            }
        }
        assert_eq!(menu_action("unknown"), None);
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
    use tauri_plugin_window_state::StateFlags;
    tauri::Builder::default()
        // Size, position and the maximized state, saved on quit and put back
        // at launch. Not visibility: a window closed (hidden) at quit must
        // still come back.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            load_zoom(&handle);
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
            // Agent notifications (#244): the delegate goes in before launch
            // finishes, so a click that launched the app still opens its
            // thread.
            #[cfg(target_os = "macos")]
            if notifications_supported() {
                let clicks = handle.clone();
                let present = handle.clone();
                let on_click = move |target| {
                    let target = match target {
                        notify::ClickTarget::Thread { file, comment: Some(comment) } => {
                            Target::Thread(file, comment)
                        }
                        notify::ClickTarget::Thread { file, comment: None } => Target::File(file),
                        notify::ClickTarget::Review(id) => Target::Review(id),
                    };
                    let app = clicks.clone();
                    std::thread::spawn(move || open_target(&app, Some(target), false));
                };
                notify::mac::install(
                    move || present.get_webview_window("main").is_some_and(|w| reader_present(&w)),
                    on_click,
                );
                notify::mac::refresh_permission(false);
                start_notification_poll(handle.clone());
            }
            std::thread::spawn(move || {
                reconcile_server_at_startup();
                open_target(&handle, None, false);
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            handle_menu(app, event.id().as_ref());
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        .on_window_event(|window, event| {
            // A drop of files on the window is a user gesture, like a Finder
            // open, so it grants access the same way (see open_target).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(target) = drop_target(paths) {
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || open_target(&app, Some(target), true));
                }
            }
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
                // Multi-file Finder opens arrive as one batch here and open
                // one at a time, in order. On a cold launch the first one
                // navigates the window to the app; the rest are held until
                // that page has loaded (PendingOpens) and then wait for the
                // SPA's hook (build_open_script), so every file opens as a
                // tab and the last one is active.
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
