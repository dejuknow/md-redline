# md-review

A local review tool for markdown files. Select text, leave comments, and hand the file to an AI agent — the agent reads your feedback, makes changes, and you verify the results in a built-in diff view.

md-review is built for the workflow that emerges when AI agents generate your specs, stories, and documentation. You need to review what the agent wrote, leave precise feedback on specific sections, and send it back for revision — the same loop you'd do with a human writer, except the other side is an agent that reads files instead of checking email. md-review gives you a visual interface for that conversation: highlight text, type your feedback, and the agent picks it up on its next read of the file.

### Inline comments — no sidecar files, no external tools

The key design decision is that comments are stored as HTML comment markers directly in the markdown file. No sidecar JSON, no database, no external service. This has several practical consequences:

- **Zero-integration agent access.** The agent reads the file and sees the comments. No API calls, no MCP servers, no tool configuration. `cat spec.md` is the entire integration.
- **Portable.** Comments travel with the file. Copy it, move it to another repo, drop it in a Slack thread — the review context stays attached. There's no dependency on a review tool being available.
- **Invisible to renderers.** GitHub, VS Code preview, Obsidian, and Zed all silently skip HTML comments. The file renders cleanly everywhere while the feedback remains embedded for anyone who looks at the source.
- **The file is the source of truth.** The agent addresses a comment and removes the marker. You diff the file to see what changed. No status syncing, no webhooks, no reconciling state across two systems.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and browse to a markdown file.

### One-command file open

```bash
# One-time setup to make md-review available globally:
npm link

# Then from anywhere:
md-review ~/specs/my-feature.md
```

Auto-starts the app if it's not running and opens the file in your browser. You can also open files via URL: `http://localhost:5173?file=/path/to/file.md`

## How it works

1. **Select text** in the rendered markdown
2. **Add a comment** with `Cmd+Enter` or click "Comment"
3. Comments are saved as **inline HTML comment markers** directly in the `.md` file
4. AI agents can read the comments with a simple file read and address them
5. **Accept or reopen** comments as the agent makes changes

Comments are stored like this:

```markdown
Some text <!-- @comment{"anchor":"highlighted text","text":"Please rewrite this","status":"open",...} -->highlighted text continues.
```

No sidecar files, no database — everything lives in the markdown. Comments are invisible in standard markdown renderers (GitHub, VS Code, Zed) but fully readable by AI agents.

## Features

### Commenting
- Select any text to add inline comments
- 8 quick templates (`Cmd+1-8`): Rewrite, Add detail, Remove, Needs example, Too vague, Fix formatting, Factually wrong, Out of scope
- Threaded replies on any comment
- Overlapping comments supported
- Drag handles to resize comment anchors
- Fuzzy re-matching when anchor text is edited externally

### Comment workflow
- **Open** → **Addressed** → **Accepted** (or **Reopened**)
- Bulk resolve all or clear accepted comments
- Filter sidebar by status (All / Open / Addressed / Accepted)
- Full-text search across comments, anchors, authors, and replies

### File management
- Multi-tab support with unresolved comment count badges
- File browser with directory navigation and breadcrumbs
- Recent files list (last 10, persistent)
- Open files via CLI, URL query param, or file browser

### Real-time collaboration with AI agents
- Detects external file changes via Server-Sent Events
- Auto-reloads and notifies when an agent addresses comments or adds replies
- Diff view to compare current content against a snapshot

### Review summary
- Cross-file summary popover showing comment stats per file
- Aggregate open/addressed/accepted counts across all tabs
- Click any file in the summary to jump to it

### Navigation
- `N` / `P` to jump between unresolved comments
- Click highlighted text to select the comment in the sidebar
- Sidebar auto-scrolls to active comment
- Cycling wraps around and skips accepted comments

### Themes
Light, Dark, Sepia, and Nord — persistent across sessions.

### Session persistence
Open tabs, active filters, view mode, sidebar state, and recent files are all restored on reload.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Enter` | Add comment on selection |
| `Cmd+1-8` | Apply quick template |
| `Cmd+Shift+M` | Start commenting on selection |
| `Cmd+\` | Toggle sidebar |
| `N` / `P` | Next / previous unresolved comment |
| `Escape` | Cancel / dismiss |

## Using with AI agents

The comment format is designed to be consumed by AI agents like Claude Code. Add this to your `CLAUDE.md` or system prompt:

> When editing markdown files, look for `<!-- @comment{...} -->` markers. Each contains JSON with:
> - `anchor`: the text being commented on
> - `text`: the reviewer's feedback
> - `status`: `open`, `addressed`, `accepted`, or `reopened`
>
> Address each comment by updating the document. Set the comment's status to `addressed` when done, or remove the marker entirely.

The agent only needs the `anchor` and `text` fields. The `id`, `timestamp`, `author`, and `replies` fields are for the UI.

## Architecture

```
├── bin/
│   └── md-review            # CLI: auto-start app + open file in browser
├── server/
│   └── index.ts             # Hono backend (file I/O, directory browsing, SSE)
├── src/
│   ├── App.tsx              # Main app: landing page + editor layout
│   ├── components/
│   │   ├── MarkdownViewer.tsx   # Renders markdown, applies comment highlights
│   │   ├── CommentSidebar.tsx   # Comment list with filters, search, bulk actions
│   │   ├── CommentCard.tsx      # Individual comment with status actions + replies
│   │   ├── CommentForm.tsx      # Floating form with templates for new comments
│   │   ├── DragHandles.tsx      # Drag handles for resizing comment anchors
│   │   ├── DiffViewer.tsx       # Side-by-side diff view
│   │   ├── ReviewSummary.tsx    # Cross-file comment summary popover
│   │   ├── FileBrowser.tsx      # Directory browser for opening files
│   │   ├── TabBar.tsx           # Multi-tab bar with comment count badges
│   │   ├── ThemeSelector.tsx    # Theme picker (Light/Dark/Sepia/Nord)
│   │   ├── Toast.tsx            # Auto-dismiss notification toasts
│   │   └── Toolbar.tsx          # Top bar with file info, status, actions
│   ├── hooks/
│   │   ├── useTabs.ts           # Multi-tab state management
│   │   ├── useSelection.ts      # Text selection detection + context capture
│   │   ├── useDragHandles.ts    # Drag-to-resize comment anchors
│   │   ├── useFileWatcher.ts    # SSE-based external change detection
│   │   ├── useSessionPersistence.ts  # Save/restore session to localStorage
│   │   ├── useRecentFiles.ts    # Recent files tracking
│   │   └── useFile.ts           # Single-file load/save (legacy)
│   ├── lib/
│   │   ├── comment-parser.ts    # Parse/insert/remove/update comments in markdown
│   │   ├── selection-resolver.ts # DOM selection → text + context
│   │   └── diff.ts              # Line-level diff algorithm
│   ├── markdown/
│   │   └── pipeline.ts          # unified/remark/rehype rendering pipeline
│   └── types.ts                 # TypeScript types
├── sample.md                    # Example spec for testing
└── index.html                   # Vite entry point
```

### Tech stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite 8
- **Markdown**: unified + remark-parse + remark-gfm + remark-rehype + rehype-raw + rehype-stringify
- **Backend**: Hono + @hono/node-server (file I/O, SSE file watching)
- **Dev**: concurrently (runs Vite + Hono together), tsx, vitest

## Development

```bash
npm run dev          # Start both servers (Vite + Hono)
npm run dev:client   # Vite only
npm run dev:server   # Hono only
npm run build        # Production build
npm test             # Run tests
npm run format       # Format code with Prettier
```

## Known issues

- **Vite file watch**: Saving `.md` files in the project directory can trigger Vite reloads. The `vite.config.ts` has `watch.ignored: [/\.md$/]` but this doesn't fully suppress it.

## License

MIT
