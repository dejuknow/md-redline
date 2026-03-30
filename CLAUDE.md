# md-redline

## What this project is

A local web app for adding inline review comments to markdown files. Think "Google Docs commenting" for `.md` files. The primary user is a product manager who generates specs/stories with AI tools and needs to leave feedback for the agent to address.

## How to run

```bash
npm install
npm run dev   # Starts Hono server (port 3001) + Vite dev server (port 5173)
```

### Quick-open a file with `mdr`

The fastest way to open a file for reviewing:

```bash
mdr /path/to/spec.md
```

This auto-starts the app if it's not running and opens the file in your browser. To make it available globally:

```bash
npm link   # one-time setup
```

`md-redline` also works as an alias for `mdr`.

You can also open a file via URL: `http://localhost:5173?file=/path/to/spec.md`

## Architecture overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- **Backend**: Hono server at `server/index.ts` — exposes `/api/file` (GET/PUT), `/api/browse`, `/api/files`, `/api/config`, `/api/watch` (SSE)
- **Markdown pipeline**: `src/markdown/pipeline.ts` — unified + remark-parse + remark-gfm + remark-frontmatter + remark-rehype + rehype-raw + rehype-sanitize + rehype-stringify
- **Comment storage**: Inline comment markers in the `.md` file: `<!-- @comment{JSON} -->`
- **Comment parser**: `src/lib/comment-parser.ts` — extracts, inserts, removes, edits, replies, bulk operations on comments
- **Highlighting**: Done in `useLayoutEffect` inside `MarkdownViewer.tsx` using ref-based innerHTML (React never manages the container's children) + DOM manipulation (`surroundContents` with `extractContents` fallback). `React.memo` prevents unnecessary re-renders.
- **CLI entry**: `bin/md-redline` — invoked as `mdr` (or `md-redline`), auto-starts the app and opens a file in the browser

## UI features

### File management
- **File explorer**: Sidebar directory navigator toggled with `Cmd+B`, with breadcrumb navigation and home shortcut
- **File browser**: Modal for opening files with full directory traversal
- **Command palette**: `Cmd+K` to search and execute commands with fuzzy filtering and keyboard navigation (arrows, vim j/k)
- **Recent files**: Quick-access list of last 10 opened files (persisted in localStorage)
- **Multi-tab support**: Open multiple files, switch between tabs; tab badges show comment counts
- **URL query param**: Open `?file=/path/to/file.md` or `?dir=/path/to/dir` to load directly
- **File reload**: Manual reload button in tab bar

### Commenting
- **Add comments**: Select text in the rendered markdown, then click "Comment" or press `Cmd+Enter`
- **Comment templates**: 8 quick templates (Rewrite, Add detail, Remove, Needs example, Too vague, Fix formatting, Factually wrong, Out of scope) via `Cmd+1-8` or the template picker
- **Edit comments**: Modify comment text after creation
- **Delete comments**: Remove individual comments
- **Threaded replies**: Add replies to any comment for discussion
- **Overlapping comments**: Multiple comments can reference overlapping text regions
- **Anchor drag-resize**: Drag handles on active comment to expand/contract the highlighted region; Escape to cancel

### Comment workflow (default: agent mode)
Comments serve as instructions to an AI agent:
1. User adds comments highlighting text and providing feedback
2. Agent reads the file, addresses the comments, and deletes the markers
3. User reviews the agent's changes via diff view
4. If the agent got something wrong, user adds new comments and repeats

Actions available on comments: Edit, Delete, Reply.

### Resolve workflow (opt-in via Settings > Enable resolve workflow)
For human-to-human review, enable the resolve workflow in settings. This adds:
- **Resolve/Reopen** actions on each comment
- **Status badges** (Open/Resolved) on comment cards
- **Filter tabs** (All/Open/Resolved) in the sidebar
- **Bulk resolve** and **Clear resolved** actions
- **Keyboard shortcuts**: `A`/`X` to resolve, `U` to reopen
- Resolved comments hide their highlights and appear dimmed
- Tab badges and navigation skip resolved comments

### Comment sidebar
- **Search**: Full-text search across comment text, anchors, authors, and replies
- **Bulk delete**: "Delete All" removes all comments from the file (or "Resolve All" / "Clear Resolved" when resolve is enabled)
- **Auto-scroll**: Sidebar scrolls to the active comment automatically
- **Footer**: Shows total comment count (or open/resolved breakdown when resolve is enabled)

### Viewing modes
- **Rendered view**: HTML-rendered markdown with comment highlights
- **Raw view**: Raw markdown with comment markers visible
- **Diff view**: Side-by-side diff comparing current content to a snapshot (take snapshot via tab bar)

### Navigation
- **Jump to next**: Press `N` or `J` to focus next comment
- **Jump to previous**: Press `P` or `K` to focus previous comment
- **Click-to-select**: Click highlighted text in the viewer to activate the comment in the sidebar
- Comment cycling wraps around

### Themes
- **Light** — white/blue accent
- **Dark** — dark slate/indigo accent
- **Sepia** — warm brown/cream for reading comfort
- **Nord** — arctic color palette

Theme selection is persistent across sessions.

### Real-time file watching
- Detects external file changes via SSE (Server-Sent Events) at `/api/watch`
- Auto-reloads with toast notification when changes are detected
- Notifies specifically about deleted comments or new replies (useful when an AI agent edits the file)
- Debounced at 150ms; skips notifications for writes initiated by the app itself

### Session persistence
All of the following are saved to localStorage and restored on reload:
- Open tabs and active tab
- Sidebar visibility
- View mode (rendered/raw/diff)
- Recent files list
- Theme selection
- Author name
- Diff snapshots (per-file)

### Keyboard shortcuts
| Shortcut | Action |
|---|---|
| `Cmd+K` | Toggle command palette |
| `Cmd+B` | Toggle file explorer |
| `Cmd+Enter` | Submit comment / expand comment form |
| `Cmd+1-8` | Apply quick template 1-8 on selection |
| `Cmd+Shift+M` | Start commenting on selection |
| `Cmd+Shift+S` | Take/update diff snapshot |
| `Cmd+\` | Toggle sidebar |
| `N` / `J` | Jump to next comment |
| `P` / `K` | Jump to previous comment |
| `A` / `X` | Resolve active comment (when resolve enabled) |
| `U` | Reopen active resolved comment (when resolve enabled) |
| `Escape` | Cancel comment form / unlock selection / cancel drag |

### Toast notifications
- Auto-dismiss after 5 seconds with fade animation
- Manual dismiss via close button
- Used for external change alerts (e.g., "Agent addressed N comments")

## Key design decisions

- Comments are stored in the markdown file itself (no sidecar files) so AI agents can read them with a simple file read
- By default, comments are instructions to the agent — once addressed, the agent deletes the markers. The diff view is the review mechanism.
- An optional "resolve workflow" setting enables resolve/reopen for human-to-human review scenarios
- Comment markers are placed **before** their anchor text — the marker's physical position in the file IS the comment's position, enabling precise matching and overlapping comments
- The `anchor` field stores the originally selected text for agent readability and as a fallback for re-matching
- Context before/after the anchor is stored for fuzzy re-matching when anchor text is edited
- Overlapping comments are allowed — multiple comments can reference overlapping text regions since each marker has a unique position
- `MarkdownViewer` uses ref-based innerHTML (not `dangerouslySetInnerHTML`) so React's reconciliation never interferes with highlight DOM modifications
- Comments support threaded replies via a `replies` array

## Known issues to fix

1. **Vite file watch** — Saving `.md` files in the project directory can trigger Vite reloads. The `vite.config.ts` has `watch.ignored: [/\.md$/]` but this doesn't fully suppress it.

## Comment format reference

Comment markers are placed **before** the text they refer to:

```
Some text <!-- @comment{"id":"uuid","anchor":"highlighted text","text":"comment text","author":"User","timestamp":"ISO-8601","replies":[]} -->highlighted text continues here.
```

- The marker sits immediately before the anchor text in the file
- `anchor` is the originally selected text — tells you what the comment refers to
- `text` is the reviewer's feedback
- `replies` is an array of `{id, text, author, timestamp}` objects for threaded discussion
- Strip all `<!-- @comment{...} -->` markers to get the clean content
- The marker's position disambiguates when the same text appears multiple times

## Parser API

Key functions in `src/lib/comment-parser.ts`:
- `parseComments(raw)` — extract comments, return clean markdown + comment array
- `insertComment(raw, anchor, text, author?, contextBefore?, contextAfter?)` — add new comment
- `removeComment(raw, id)` — delete comment
- `editComment(raw, id, newText)` — update comment text
- `addReply(raw, id, text, author?)` — add threaded reply
- `removeAllComments(raw)` — delete all comments
- `resolveComment(raw, id)` — set status to `resolved` (when resolve enabled)
- `unresolveComment(raw, id)` — set status back to `open` (when resolve enabled)
- `resolveAllComments(raw)` — bulk resolve all open comments
- `removeResolvedComments(raw)` — delete all resolved comments
- `updateCommentAnchor(raw, id, newAnchor)` — change anchor text (drag-resize)
- `detectMissingAnchors(cleanMarkdown, comments)` — returns Set of comment IDs whose anchor can't be found

## Testing

```bash
npm test              # Unit tests (vitest, single run)
npm run test:watch    # Unit tests in watch mode
npm run test:e2e      # Playwright e2e tests (chromium)
npm run test:e2e:ui   # Playwright with interactive UI
```

**Unit tests** (`src/lib/`):
- `comment-parser.test.ts` — comprehensive coverage of all parser functions, edge cases, fuzzy re-matching
- `diff.test.ts` — LCS-based line diff algorithm

**E2E tests** (`e2e/`):
- `commenting.spec.ts` — core commenting workflow (create, edit, delete, reply)
- `advanced.spec.ts` — themes, multi-tab, bulk operations, file watching
- `drag-regression.spec.ts` — regression tests for anchor drag-resize across formatting boundaries

## Eval framework

Evaluates how well AI agents handle review comments in markdown files.

```bash
npm run eval              # Run full eval suite
npm run eval:dry          # Dry run (validate fixtures, no agent calls)
```

### CLI options

```
--case, -c <string>     Filter cases by name substring
--format, -f <string>   Format variant (default: "current")
--agent, -a <string>    Agent adapter (default: "claude-cli")
--dry-run               Validate fixtures without running agents
--verbose, -v           Print detailed scoring per case
```

### Fixture structure

Each case is a directory under `eval/fixtures/` with three files:
- `input.md` — markdown with embedded `<!-- @comment{} -->` markers
- `prompt.txt` — instruction for the agent
- `expected.json` — scoring criteria (totalComments, actionableComments, per-comment expectedAction, contentAssertions)

10 fixtures: single-rewrite, mixed-statuses, overlapping-anchors, vague-comment, code-block, deletion-request, threaded-comments, large-file, no-comments, frontmatter.

### Scoring dimensions

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| parsing | 25% | Were comment markers correctly removed after being addressed? |
| execution | 50% | Did content changes actually address the feedback? |
| integrity | 25% | Is the output valid markdown with no leftover malformed markers? |

Results are saved to `eval/results/<timestamp>_<agent>_<format>/` with per-case `scores.json` and a run-level `summary.json`.
