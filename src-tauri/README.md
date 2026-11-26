# mdr desktop shell

A thin macOS desktop app around the same local `mdr` server. It exists only on
the long-living `tauri-shell` branch and is not intended to merge to `main`.

The point of the shell is to end browser-tab pileup: instead of every
`mdr foo.md` spawning a new tab you can lose among dozens, docs open in one
findable app window that focuses on demand.

## What it is (and isn't)

The shell is a pure client. It does not bundle a server. It discovers the
running `mdr` server (same port-file, port-scan, and `/api/config` health
check the CLI uses) and points one webview window at `http://127.0.0.1:PORT`.
If nothing is running it starts the stack by shelling out to `mdr --no-open`.

All product logic lives in the web app. This crate only handles window
lifecycle, the `mdr://` deep link, `.md` file associations, and routing
external links to the system browser.

## Prerequisites

- macOS (the only supported target for now).
- Node with the repo installed and `mdr` linked on your `PATH` (the shell
  starts the server through an interactive login shell, `$SHELL -lic`, so
  `mdr` must resolve in a normal terminal; PATH set up in `~/.zshrc`, as
  nvm does, is picked up).
- A Rust toolchain (`rustup default stable`). Built and tested against Rust
  1.97 and Tauri v2.

## Build and run

From the repo root:

```bash
npm run app:dev            # tauri dev: hot-reloading shell for development
npm run app:build          # optimized release .app bundle
npx tauri build --debug    # fast debug .app bundle, good for dogfooding
```

The debug bundle lands at
`src-tauri/target/debug/bundle/macos/mdr.app`; the release bundle at
`src-tauri/target/release/bundle/macos/mdr.app`. To install, copy the bundle
to `/Applications` (that also makes it visible to Spotlight and Raycast).

Launch the built app once so macOS registers its `mdr://` scheme and `.md`
file associations with LaunchServices:

```bash
open src-tauri/target/debug/bundle/macos/mdr.app
```

Icons are generated from the web app's favicon:

```bash
npx tauri icon icon-1024.png   # a red squircle composite of public/favicon.svg
```

## Opening documents

Once the app is installed, the CLI prefers it automatically:

```bash
mdr foo.md          # opens (or focuses) the app on foo.md
mdr ~/notes         # re-roots the app's file explorer at a directory
mdr                 # brings the existing window forward
```

`mdr` tries the `mdr://` deep link first and falls back to the browser when
the app is not installed. Opens land on top of what you already have open: a
file adds or activates a tab, a directory re-roots the explorer, existing tabs
survive. A bare `mdr` or Dock click never navigates away from an open doc.

Finder "Open With mdr" (and double-clicking `.md`/`.markdown` files once the
association is set) opens files the same way, without going through the CLI.

## CLI options

These live in `bin/cli.js` and apply whether or not the app is installed:

| Flag | Effect |
| --- | --- |
| `--browser` | Open in the default browser even when the app is installed. Position independent (`mdr --browser foo.md` or `mdr foo.md --browser`). |
| `--no-open` | Start the server without opening anything. Used by the shell to boot the stack. |

Use `--` before a filename that starts with `-`. Unknown dash-args are
reported rather than silently treated as a filename.

## Behavior notes

- **External links** in rendered markdown open in the system browser, not the
  webview. Loopback and internal schemes (`tauri://`, `about:blank`) load
  in-app; any other `http(s)`/`mailto`/`tel` URL is handed to `open`.
- **Window lifecycle**: Cmd-W hides the window (the app stays in the Dock),
  clicking the Dock icon brings it back, Cmd-Q quits.
- **Zoom**: starts at 125% to match a typical browser zoom; Cmd +/- adjust it.
  The default is applied once per launch so a manual change is not clobbered by
  later opens. Zoom does not persist across restarts yet.
- **MCP reviews**: agent-triggered reviews also prefer the app, via
  `mdr://open?review=<id>` (browser fallback as usual).

## Dev-mode gotcha

When the shell has to start the server it runs the globally linked `mdr`,
which picks production vs dev solely by whether `dist/server.js` exists. A
stale `dist/` (for example, left by `npm test`, which builds first) makes
`npm run app:dev` silently boot the production server with no HMR. Fix:
`mdr --stop`, then start `npm run dev` yourself before relying on the shell's
auto-start.

## Where things live

| Path | Purpose |
| --- | --- |
| `src/main.rs` | The whole shell: server discovery, window lifecycle, deep link and file-association handling, external-link routing. |
| `tauri.conf.json` | Bundle config, identifier (`com.dejuknow.mdr`), file associations. The main window is built in code, not declared here, because init scripts and nav handlers are builder-only. |
| `Info.plist` | Registers the `mdr://` URL scheme. |
| `loading/index.html` | The spinner shown at launch while the server is discovered. |
| `capabilities/default.json` | Baseline permissions. The remote SPA gets no IPC access. |
| `icons/` | App icon set (committed). |

For the agent-facing version of this documentation, see the "Desktop shell"
section of `AGENTS.md`.
