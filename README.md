# <img src="public/favicon.svg" width="30" align="center" /> md-redline

[![npm version](https://img.shields.io/npm/v/md-redline)](https://www.npmjs.com/package/md-redline)

Inline review comments for markdown specs, prompts, and design docs.

Highlight text in a rendered document, leave comments, and your AI agent can read and address them directly. Comments are stored as invisible HTML markers in the `.md` file itself. No sidecar files, no database, no external service. The markdown file stays the source of truth.

With the built-in MCP server, your agent can request a review mid-task and pause until you click **Send review**. You leave your feedback, the agent picks up where it left off. No copy-paste, no context switching.

![md-redline screenshot](https://raw.githubusercontent.com/dejuknow/md-redline/main/public/screenshot.png)

**See the full review workflow in 30 seconds:**

https://github.com/user-attachments/assets/855a9d02-b0fd-4dec-b0a5-742871e8c181

Works with [Claude Code](https://claude.com/claude-code), Claude Desktop, [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), and any other MCP client that supports stdio servers. As Sean Grove argues in [specs are the new code](https://www.youtube.com/watch?v=8rABwKRsec4), specs are becoming the primary unit of work in agentic development. `mdr` gives that workflow review tooling closer to code review.

## Quick start

Prerequisite: Node 20 or newer.

```bash
npx md-redline /path/to/spec.md
```

This starts the local app if needed and opens it in your browser.

Or install globally:

```bash
npm install -g md-redline
mdr /path/to/spec.md        # Open a file
mdr /path/to/dir             # Open a directory
mdr --stop                   # Stop the running server
```

`md-redline` also works as an alias for `mdr`.

## MCP setup

Register the MCP server with your agent so it can request reviews mid-task.

### Claude Code or Claude Desktop

```bash
mdr mcp install                   # register with both clients (default)
mdr mcp install --claude-code     # just Claude Code (via `claude mcp add`)
mdr mcp install --claude-desktop  # just Claude Desktop (JSON config file)
```

### Codex CLI

```bash
codex mcp add md-redline -- mdr mcp
```

### Gemini CLI

```bash
gemini mcp add --scope user md-redline mdr mcp
```

The `--scope user` flag is important. Gemini defaults to per-project scope, which only registers mdr for the current directory.

### Other MCP clients

Add this server entry to your client's MCP config file:

```json
{
  "mcpServers": {
    "md-redline": {
      "command": "mdr",
      "args": ["mcp"]
    }
  }
}
```

Prerequisite: `mdr` must be on your `PATH` (e.g. via `npm install -g md-redline`). If your client spawns subprocesses without inheriting your shell's `PATH`, use the absolute path from `which mdr` as the `command` value.

## Review workflow

### With MCP (recommended)

Once registered, ask your agent to request a review:

> "Let me review docs/specs/feature-x.md in mdr before you continue."

The agent calls `mdr_request_review`, mdr opens the file, you highlight text and leave comments, then click **Send review**. The agent receives your feedback as a structured prompt and starts addressing your comments. The review is opt-in per request. The agent only pauses when you ask for it.

### Without MCP

1. Open a markdown file with `mdr /path/to/spec.md`.
2. Highlight text and leave inline comments.
3. Copy the hand-off prompt.
4. Paste the prompt into your AI agent.
5. The agent edits the file, addresses the feedback, and removes the comment markers it handled.
6. Review the result in diff view.

### Optional: resolve workflow

Enable resolve mode in Settings for human review with explicit `open` and `resolved` states.

## Who this is for

- **People writing specs, prompts, or design docs locally** with file-based AI agents
- **Teams reviewing docs before they are committed** or sent out for wider review
- **Anyone in a human + agent editing loop** who wants structured inline feedback in plain files

### Non-goals

- Not a collaborative multi-user editing tool.
- Not a replacement for GitHub PR reviews (use those once the file is in git).
- Not designed for untrusted content. This is a local dev tool for your own files.

## How comments are stored

Comments are stored as invisible HTML markers directly in the markdown, immediately before the text they refer to, so both humans and agents can work from the same file.

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

This makes feedback:

- visible to AI agents via a plain file read
- portable with the markdown file
- invisible in normal renderers (GitHub, VS Code preview)

## Features

### Review and commenting

- Inline comments anchored to rendered text, including overlapping comments
- Threaded replies and optional `open` / `resolved` review states
- Adjustable anchors with drag handles
- Rendered, raw, and diff views
- Hand-off prompt copying for one or multiple files

### Navigation and editing

- Multi-tab editing with session persistence and tab context menus
- File explorer, recent files, and native OS file picker
- Find in document (`Cmd+F`) with match navigation
- Table of contents with scroll spy
- Command palette (`Cmd+K`), keyboard shortcuts, and settings panel (`Cmd+,`)
- Resizable panels and right-click context menus

### Rendering and integrations

- Real-time reload via SSE when files change externally
- Mermaid diagram rendering with commentable text
- Local image embeds and clickable links between markdown files
- Customizable comment templates
- 8 themes: Light, Dark, Sepia, Nord, Solarized, GitHub, Rosé Pine, Catppuccin

## Supported platforms

- **macOS**: supported
- **Linux**: supported; system file picker requires `zenity`
- **Windows**: supported; system file picker uses PowerShell

## Permissions

By default, md-redline can read any markdown file in your home directory. The first time you run `mdr` (or the first time after upgrading from a version without the trusted-roots feature), your home folder is added to a trusted-roots list at `~/.md-redline.json`. Files outside your home directory (`/tmp`, mounted volumes, system paths) require an explicit permission grant via the OS folder picker the first time you open them. Granted folders are remembered across restarts.

To use the strict per-folder model instead, run `mdr --restrict` once after install. This creates a `~/.md-redline.json` with no default trust, and you'll grant each folder explicitly the first time you open a file in it.

File saves use atomic write-then-rename and mtime-based conflict detection to prevent data loss from concurrent edits. Mermaid SVG output is sanitized via DOMPurify before rendering. Only run md-redline in environments you trust.

## Development

### From source

```bash
git clone https://github.com/dejuknow/md-redline.git
cd md-redline
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5188`).

### Scripts

```bash
npm run dev          # Start dev server
npm run lint         # Lint
npm test             # Production build + unit tests
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
