# mdr desktop app

An optional macOS app around the same local `mdr` server. Instead of every
`mdr foo.md` opening another browser tab you can lose among dozens, docs open
in one app window that comes forward on demand.

The npm package stays the way to install mdr. The app needs it: it does not
bundle a server, and it is not part of the npm package. For now you build it
from source.

## What it is (and isn't)

The app is a pure client. It finds the running `mdr` server (the same port
file, port scan and `/api/config` home check the CLI uses) and points one
window at `http://127.0.0.1:PORT`. If nothing is running it starts the stack
by running `mdr --no-open`.

All product logic lives in the web app. This crate only handles the window,
the `mdr://` link, the `.md` file association, and sending external links to
the system browser.

## Prerequisites

- macOS. Windows and Linux are not supported yet.
- `mdr` on your `PATH`, from npm (`npm install -g md-redline`) or linked from
  this checkout (`npm link`), at a version that knows `mdr --no-open` (the
  first release that ships with this app, or later). The app starts the server
  through an interactive login shell (`$SHELL -lic`), so `mdr` must resolve in
  a normal terminal; a `PATH` set up in `~/.zshrc`, as nvm does, is picked up.
- A Rust toolchain (`rustup default stable`). Built and tested with Rust 1.97
  and Tauri 2.11.
- The repo's npm dependencies (`npm ci`), which include the Tauri CLI.

## Build and run

From the repo root:

```bash
npm run app:dev            # tauri dev: the app with a live-reloading shell
npm run app:build          # optimized release .app bundle
npx tauri build --debug    # faster debug .app bundle
```

The debug bundle lands at `src-tauri/target/debug/bundle/macos/mdr.app`, the
release bundle at `src-tauri/target/release/bundle/macos/mdr.app` (under
`$CARGO_TARGET_DIR` instead when that is set). To install, copy the bundle to
`/Applications`, which also makes it visible to Spotlight and Raycast.

Launch the built app once so macOS registers its `mdr://` scheme and `.md`
file association:

```bash
open src-tauri/target/debug/bundle/macos/mdr.app
```

To make it the default app for Markdown files, use Finder: Get Info on any
`.md` file, choose mdr under "Open with", then "Change All...".

Rust tests: `cargo test` in this directory.

Icons are generated from the web app's favicon:

```bash
npx tauri icon icon-1024.png   # a red squircle composite of public/favicon.svg
```

## Opening documents

Once the app is installed, the CLI prefers it:

```bash
mdr foo.md          # opens (or focuses) the app on foo.md
mdr ~/notes         # shows a folder in the app's file explorer
mdr                 # brings the existing window forward
```

`mdr` tries the `mdr://` link first and falls back to the browser when the app
is not installed. Opens land on top of what you already have open: a file adds
or activates a tab, a folder is shown in the explorer, existing tabs stay. A
bare `mdr` or a Dock click never navigates away from an open doc.

The CLI keeps the browser when the app might not find the same server: with
`MD_REDLINE_BROWSER` or `MDR_BROWSER` set, with `MD_REDLINE_HOME` pointing at
another home, or with a port named by `MD_REDLINE_PORT` or `PORT`.

Finder "Open With mdr" (and double-clicking `.md` files once mdr is the
default) opens files the same way, without going through the CLI.

## CLI options

These live in `bin/cli.js` and work whether or not the app is installed:

| Flag | Effect |
| --- | --- |
| `--browser` | Open in the default browser even when the app is installed. Goes before or after the target (`mdr --browser foo.md` or `mdr foo.md --browser`). |
| `--no-open` | Start the server without opening anything. The app uses it to start the stack. |

Use `--` before a filename that starts with `-`. Unknown options are reported
rather than taken for a filename.

## Behavior notes

- **External links** in rendered markdown open in the system browser, not the
  app window, and so do links to other local services (a dev server on
  `localhost:3000`, say). Only mdr's own pages and internal schemes
  (`tauri://`, `about:blank`) load in the app.
- **Tabs**: Cmd-T opens a file in a new tab, Cmd-W closes the active tab and
  Shift-Cmd-T reopens the last closed one (File menu). Cmd-W with no tab open
  hides the window, and Shift-Cmd-T brings it back with the reopened tab.
  Ctrl-Tab and Ctrl-Shift-Tab move to the next and previous tab, Cmd-1 to
  Cmd-8 go to that tab and Cmd-9 to the last one (Go menu).
- **Menus**: View toggles the explorer, outline, comments and focus mode with
  the same keys as in the browser; Go also has Next and Previous Comment;
  Settings is in the app menu (Cmd-,); Help has the keyboard shortcuts and
  links to GitHub, issues and release notes; File > Show in Finder reveals
  the active tab's file.
- **Window**: closing the window hides it and the app stays in the Dock;
  clicking the Dock icon brings it back, Cmd-Q quits. Its size and position
  are kept across restarts; a window saved on a monitor that is gone comes
  back on the main screen.
- **Zoom**: View > Zoom In (Cmd-=) and Zoom Out (Cmd--) step from 80% to 200%;
  Actual Size (Cmd-0) returns to 125%, the size the app is drawn for. The
  level is kept across restarts.
- **Drag and drop**: drop .md files on the window to open them as tabs (the
  first one dropped is shown), or a folder to show it in the explorer. Other
  files are ignored.
- **MCP reviews**: agent-triggered reviews also prefer the app, through
  `mdr://open?review=<id>` (browser fallback as usual).
- **Start log**: when the app starts the server, the output goes to
  `~/Library/Logs/mdr/server-start.log`. The server it starts runs from your
  home folder, so it trusts that folder even in restricted mode
  (`mdr --restrict`), as `mdr` run from your home would. To keep it narrower,
  start mdr yourself from a project folder before opening the app.
- **Version**: the app has its own version number (About mdr), separate from
  the npm package's.

## Dev-mode gotcha

When the app has to start the server it runs the `mdr` on your `PATH`, which
picks production vs dev solely by whether `dist/server.js` exists. A stale
`dist/` (for example, left by `npm test`, which builds first) makes
`npm run app:dev` silently boot the production server with no HMR. Fix:
`mdr --stop`, then start `npm run dev` yourself before relying on the app's
auto-start.

## Where things live

| Path | Purpose |
| --- | --- |
| `src/main.rs` | The whole shell: server discovery, window lifecycle and placement, menus, zoom, link, file-association and drop handling, external-link routing. |
| `scripts/tab-keys.js` | Tab keys injected into the page: Ctrl+Tab everywhere, plus Ctrl+T, Ctrl+W, Ctrl+Shift+T and Ctrl+1 to Ctrl+9 on Windows and Linux (macOS uses its menus). |
| `tauri.conf.json` | Bundle config, identifier (`com.dejuknow.mdr`), file association. The main window is built in code, not declared here, because init scripts and navigation handlers are builder-only. |
| `Info.plist` | Registers the `mdr://` URL scheme. |
| `loading/index.html` | The spinner shown at launch while the server is found. |
| `capabilities/default.json` | Baseline permissions for the loading window. |
| `capabilities/window-drag.json` | Lets the loopback mdr page drag and zoom its own window (the overlay title bar), nothing else. |
| `icons/` | App icon set (committed). |

For the agent-facing version of this documentation, see the "Desktop app"
section of `AGENTS.md`.
