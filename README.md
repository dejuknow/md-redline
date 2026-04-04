# <img src="public/favicon.svg" width="30" align="center" /> md-redline

Inline review for markdown files, built for human + AI agent workflows.

Sean Grove makes the case that [specs are the new code](https://www.youtube.com/watch?v=8rABwKRsec4). Markdown has become the standard for structured documents between humans and AI agents, and it needs review tooling the way code already has it. That's what `mdr` is.

Agents read and write markdown all day, but they don't participate in review UIs. `mdr` bridges that gap: you leave inline comments in a rendered markdown view, the agent addresses them by reading the same `.md` file. No sidecar files, no database, no external service. The markdown file is the source of truth.

## How it works

1. Open a markdown file in `mdr` (often one an agent just generated or edited)
2. Highlight text, leave inline comments
3. <!-- @comment{"id":"0fe00629-8a8d-4d23-8e43-0c8a215da617","anchor":"Click \"Hand off to agent\" (copies instructions + takes a diff snapshot)","text":"Instead of Click \"Hand off to agent\" (a button that new users are unfamiliar with), this should be something like \"Click the hand-off button to copy instructions\"\n\nWe also need a step after this that the instructions need to be pasted to the agent","author":"Dennis","timestamp":"2026-04-04T02:41:37.756Z","contextBefore":")\nHighlight text, leave inline comments\n","contextAfter":"\nThe agent reads the file, addresses you"} -->Click "Hand off to agent" (copies instructions + takes a diff snapshot)
4. The agent reads the file, addresses your feedback and removes the comments
5. Review the agent's changes in diff view
6. Repeat until done

## Quick start

Prerequisite: Node 20 or newer.

```bash
npx md-redline /path/to/spec.md
```

Or install globally:

```bash
npm install -g md-redline
mdr /path/to/spec.md        # Open a file
mdr /path/to/dir             # Open a directory
mdr --stop                   # Stop the running server
```

`md-redline` also works as an alias for `mdr`.

### From source

```bash
git clone https://github.com/dejuknow/md-redline.git
cd md-redline
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5188`).

## How comments work

Comments are stored as invisible HTML markers directly in the markdown, so both humans and agents can work from the same file.

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

This keeps feedback:

- visible to AI agents via a plain file read
- portable with the markdown file
- invisible in normal renderers (GitHub, VS Code preview)

## Who this is for

- **Spec authors** writing markdown specs, prompts, or design docs locally with file-based AI agents
- **Teams** doing pre-commit review on docs that haven't hit git yet
- **Anyone** in a human + agent editing loop who needs structured inline feedback in plain files

### Non-goals

- Not a collaborative multi-user editing tool
- Not a replacement for GitHub PR reviews (use those once the file is in git)
- Not designed for untrusted content. This is a local dev tool for your own files

## Features

- Inline comments with overlapping anchors, threaded replies, drag-resize anchors
- Multi-tab editing with tab context menus
- File explorer, recent files, native OS file picker
- Command palette (`Cmd+K`) and keyboard shortcuts
- Rendered, raw, and diff views
- Find in document (`Cmd+F`) with match navigation
- Table of contents with scroll spy
- Real-time reload via SSE when files change externally
- Optional resolve workflow for human review
- Agent hand-off prompt copying for one or multiple files
- Mermaid diagram rendering with commentable text
- 8 themes: Light, Dark, Sepia, Nord, Solarized, GitHub, Rosé Pine, Catppuccin
- Customizable comment templates
- Resizable panels, right-click context menus, settings panel (`Cmd+,`)
- Session persistence across tabs and panel layout

## Review workflows

### Default: comments as agent instructions

The reviewer adds comments, hands off to the agent, and the agent addresses them in-place by deleting the markers. The reviewer checks the diff.

### Optional: resolve workflow

Enable in Settings for human-to-human review with explicit `open` / `resolved` states.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+K` / `Ctrl+K` | Toggle command palette |
| `Cmd+B` / `Ctrl+B` | Toggle file explorer |
| `Cmd+F` / `Ctrl+F` | Find in document |
| `Cmd+O` / `Ctrl+O` | Open file |
| `Cmd+,` / `Ctrl+,` | Open settings |
| `Cmd+Enter` / `Ctrl+Enter` | Submit comment / expand comment form |
| `Cmd+Shift+M` / `Ctrl+Shift+M` | Lock selection for commenting |
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Toggle document outline |
| `Cmd+Shift+[ / ]` / `Ctrl+Shift+[ / ]` | Previous / next tab |
| `Cmd+\` / `Ctrl+\` | Toggle comments sidebar |
| `N` / `J` | Next comment |
| `P` / `K` | Previous comment |
| `D` | Delete active comment |
| `A` / `X` | Resolve active comment |
| `U` | Reopen active comment |
| `?` | Show keyboard shortcuts help |
| `Escape` | Cancel form, unlock selection, or cancel drag |

## Supported platforms

- **macOS**: supported
- **Linux**: supported; system file picker requires `zenity`
- **Windows**: supported; system file picker uses PowerShell


## Security model

`mdr` is a local dev tool. The server reads and writes markdown files inside the current working directory, the user's home directory, and any path passed at startup. File saves use atomic write-then-rename and mtime-based conflict detection to prevent data loss from concurrent edits.

Only run it in environments you trust. Mermaid SVG output is sanitized via DOMPurify before rendering.

## Development

```bash
npm run dev          # Start dev server
npm run lint         # Lint
npm test             # Unit tests
npm run test:e2e     # Playwright E2E tests
npm run build        # Production build
```

### Agent eval

The eval harness tests whether AI agents correctly read, address, and remove inline comments.

- `npm run eval:dry` validates eval fixtures
- `npm run eval` runs the full eval harness
- See [eval/README.md](./eval/README.md) for details

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

## License

[MIT](./LICENSE)
