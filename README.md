# md-redline

*Reviewing markdown with AI agents shouldn't require leaving the file.*

`mdr` is a local app for inline review of markdown files — built for the loop between humans and AI agents.

Highlight text, leave inline comments, and hand the file to an agent or teammate. Comments are stored as HTML comment markers directly in the `.md` file — no sidecar files, no database, no external service. The file is the source of truth.

## Why it exists

AI agents can read and write files, but they can't use review UIs. `mdr` bridges that gap: you review in a rendered view, and the agent addresses your feedback by reading the same file.

1. open a markdown file
2. highlight text
3. leave inline comments
4. let an agent address them in-place
5. review the result in raw or diff view

## How comments work

Comments are stored immediately before the text they refer to:

```markdown
Some text <!-- @comment{
  "id":"uuid",
  "anchor":"highlighted text",
  "text":"Rewrite this section to be clearer.",
  "author":"User",
  "timestamp":"2026-03-26T12:00:00.000Z",
  "replies":[]
} -->highlighted text continues here.
```

The app writes the same marker inline on one line; it is expanded here only for readability.

That design keeps the feedback:

- visible to AI agents with a plain file read
- portable with the markdown file
- invisible in normal markdown renderers like GitHub and VS Code preview
- resilient in rendered Mermaid diagrams: diagram anchors are matched against visible label text, not hidden SVG metadata or injected CSS text

## Current feature set

- Inline comments with overlapping anchors
- Newly added comments become active and focused in the sidebar
- Threaded replies with inline edit/delete
- Drag-resize comment anchors
- Multi-tab editing with tab context menus (close, close others, close to right)
- File explorer, recent files, and native OS file picker
- Command palette (`Cmd+K`) and comprehensive keyboard shortcuts
- Rendered, raw, and diff views
- Find in document (`Cmd+F`) with match counting and navigation
- Table of contents with active heading tracking and scroll spy
- Comment sidebar search across text, anchors, authors, and replies
- Real-time reload via SSE when files change outside the app
- Optional resolve workflow for human review
- Agent hand-off prompt copying for one or multiple files
- Mermaid rendering with commentable diagram text
- 8 themes: Light, Dark, Sepia, Nord, Solarized, GitHub, Rosé Pine, Catppuccin
- Customizable comment templates (add, remove, reorder via drag-and-drop)
- Quick comment mode (skip the "Comment" button, open form immediately on selection)
- Resizable panels with draggable dividers between explorer, viewer, and sidebar
- Right-click context menus on tabs, files, comments, and selections
- Settings panel (`Cmd+,`) with General, Templates, and Theme tabs
- Session persistence: open tabs, panel layout, panel widths, view mode, and diff snapshots saved to localStorage; author, theme, recent files, and settings are also mirrored to `~/.md-redline.json`

## Supported platforms

- macOS: supported
- Linux: supported for the core app; the system file picker requires `zenity`
- Windows: supported for the core app and CLI; the system file picker uses PowerShell

## Quick start

Prerequisite: Node 20 or newer.

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite in your terminal. By default this is usually `http://localhost:5188`, but it may move to the next available port.

## Open a file quickly

```bash
npm link
mdr /path/to/spec.md        # Open a file
mdr /path/to/dir             # Open a directory
mdr --stop                   # Stop the running server
mdr -h                       # Show help
```

`md-redline` also works as an alias for `mdr`.

On Windows, the same CLI works with paths like:

```powershell
mdr C:\docs\spec.md
mdr .\spec.md
```

You can also open a file or directory directly by URL:

- `http://localhost:<vite-port>?file=/absolute/path/to/file.md`
- `http://localhost:<vite-port>?dir=/absolute/path/to/folder`

Use the actual client port Vite is running on. On Windows, absolute paths like `C:\docs\spec.md` work as well.

## Review workflows

### Default workflow: comments as agent instructions

By default, comments are instructions to an agent:

1. the reviewer adds comments
2. the reviewer clicks "Hand off to agent" — this copies instructions to the clipboard and takes a diff snapshot
3. the agent reads the file and updates the content
4. the agent deletes the addressed markers
5. the reviewer checks the result in diff view

### Optional resolve workflow

If you enable the resolve workflow in Settings, comments get explicit `open` and `resolved` states for human-to-human review.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+K` / `Ctrl+K` | Toggle command palette |
| `Cmd+B` / `Ctrl+B` | Toggle file explorer |
| `Cmd+F` / `Ctrl+F` | Find in document |
| `Cmd+O` / `Ctrl+O` | Open file |
| `Cmd+,` / `Ctrl+,` | Open settings |
| `Cmd+Enter` / `Ctrl+Enter` | Submit comment / expand comment form |
| `Cmd+1-8` / `Ctrl+1-8` | Apply quick template |
| `Cmd+Shift+M` / `Ctrl+Shift+M` | Start commenting on selection |
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Toggle document outline |
| `Cmd+Shift+[ / ]` / `Ctrl+Shift+[ / ]` | Previous / next tab |
| `Cmd+\` / `Ctrl+\` | Toggle comments sidebar |
| `N` / `J` | Next comment |
| `P` / `K` | Previous comment |
| `D` | Delete active comment |
| `A` / `X` | Resolve active comment when resolve workflow is enabled |
| `U` | Reopen active comment when resolve workflow is enabled |
| `?` | Show keyboard shortcuts help |
| `Escape` | Cancel form, unlock selection, or cancel drag |

## Architecture

```text
bin/md-redline             CLI entry point (invoked as `mdr` or `md-redline`)
server/index.ts            Hono server for file I/O, browsing, SSE, and local integrations
src/App.tsx                Main application shell
src/components/            Viewer, sidebar, raw view, diff view, TOC, explorer, settings, etc.
src/hooks/                 State, persistence, selection, file watching, drag handles, tabs
src/lib/comment-parser.ts  Inline comment parsing and mutation helpers
src/markdown/pipeline.ts   Markdown rendering pipeline
eval/                      Eval harness for agent behavior against inline comments
e2e/                       Playwright end-to-end coverage
```

## Development

```bash
npm run dev
npm run lint
npm test
npm run test:e2e
```

On Windows, you can use the helper script to set up and run tests:

```powershell
.\bin\test-windows.ps1 -Headed  # Run E2E tests with a visible browser
.\bin\test-windows.ps1 -UI      # Open Playwright UI
.\bin\test-windows.ps1          # Standard headless run
```

Useful scripts:

- `npm run dev:server`
- `npm run dev:client`
- `npm run build`
- `npm run test:watch`
- `npm run test:e2e:ui`

### Eval

- `npm run eval:dry` validates eval fixtures only
- `npm run eval` runs the full eval harness and writes scored results to `eval/results/`
- The eval is a file-based regression harness for agent handling of inline markdown comments, not a UI benchmark
- The current eval adapter id is `claude-cli`; it shells out to the local `claude` CLI, and the effective model is whatever that CLI is configured to use by default
- See [eval/README.md](./eval/README.md) for fixture structure, scoring, and flags

## Security model

`mdr` is a local app. The server can read and write markdown files inside:

- the current working directory
- the current user's home directory
- any initial file or directory passed at startup

This is intentional so the tool can work with real docs on your machine, but it also means you should only run it in environments you trust.

## License

[MIT](./LICENSE)
