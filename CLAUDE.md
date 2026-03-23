# md-review

## What this project is

A local web app for adding inline review comments to markdown files. Think "Google Docs commenting" for `.md` files. The primary user is a product manager who generates specs/stories with AI tools and needs to leave feedback for the agent to address.

## How to run

```bash
npm install
<!-- @comment{"id":"3768d139-dd07-4817-9199-c7e1996feb24","anchor":"npm run dev   # Starts Hono server (port 3001) + Vite dev server (port 5173)","text":"gsdag","author":"Dennis","timestamp":"2026-03-23T02:53:41.956Z","resolved":false,"status":"open","contextBefore":"agent to address.\nHow to run\nnpm install","contextAfter":")\n\nQuick-open a file with md-review\nThe "} -->npm run dev   # Starts Hono server (port 3001) + Vite dev server (port 5173)
```

### Quick-open a file with `md-review`

The fastest way to open a file for reviewing:

```bash
md-review /path/to/spec.md
```

This auto-starts the app if it's not running and opens the file in your browser. To make it available globally:

```bash
npm link   # one-time setup
```

<!-- @comment{"id":"3133b3f2-bf74-47fe-94d0-033258d56a8e","anchor":"You can also open a file via URL: http://localhost:5173?file=/path/to/spec.md\n\nArchitecture o","text":"asf","author":"Dennis","timestamp":"2026-03-23T02:53:37.397Z","resolved":false,"status":"open","contextBefore":"le globally:\nnpm link   # one-time setup","contextAfter":"overview\n\nFrontend: React 19 + TypeScrip"} -->You can also open a file via URL: `http://localhost:5173?file=/path/to/spec.md`

## Architecture overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- **Backend**: Hono server at `server/index.ts` — exposes `/api/file` (GET/PUT), `/api/browse`, `/api/files`, `/api/config`
- **Markdown pipeline**: `src/markdown/pipeline.ts` — unified + remark-parse + remark-rehype + rehype-raw + rehype-stringify
- **Comment storage**: Inline comment markers in the `.md` file: `<!-- @comment{JSON} -->`
- **Comment parser**: `src/lib/comment-parser.ts` — extracts, inserts, removes, resolves, edits, replies, bulk operations on comments
- **Highlighting**: Done in `useLayoutEffect` inside `MarkdownViewer.tsx` using ref-based innerHTML (React never manages the container's children) + DOM manipulation (`surroundContents` with `extractContents` fallback). `React.memo` prevents unnecessary re-renders.
- **CLI entry**: `bin/md-review` — shell script to auto-start the app and open a file in the browser

## UI features

### File management
- **File browser**: Navigate directories with breadcrumb navigation and home shortcut
- **Path input**: Type an absolute path to open any `.md` file
- **Recent files**: Quick-access list of last 10 opened files (persisted in localStorage)
- **Multi-tab support**: Open multiple files, switch between tabs; tab badges show unresolved comment counts
- **URL query param**: Open `?file=/path/to/file.md` to load a file directly
- **File reload**: Manual reload button in toolbar

### Commenting
- **Add comments**: Select text in the rendered markdown, then click "Comment" or press `Cmd+Enter`
- **Comment templates**: 8 quick templates (Rewrite, Add detail, Remove, Needs example, Too vague, Fix formatting, Factually wrong, Out of scope) via `Cmd+1-8` or the template picker
- **Edit comments**: Modify comment text after creation
- **Delete comments**: Remove individual comments
- **Threaded replies**: Add replies to any comment for discussion
- **Overlapping comments**: Multiple comments can reference overlapping text regions
- **Anchor drag-resize**: Drag handles on active comment to expand/contract the highlighted region; Escape to cancel

### Comment statuses
- **open** — initial state when a comment is created
- **resolved** — the comment has been addressed and resolved; highlights are hidden

Status transitions in the UI:
- Open: Edit, Resolve, Delete
- Resolved: Reopen, Delete

### Comment sidebar
- **Filter tabs**: All, Open, Resolved — each shows a count
- **Search**: Full-text search across comment text, anchors, authors, and replies
- **Bulk resolve**: "Resolve All" marks all open comments as resolved
- **Clear resolved**: "Clear Resolved" removes all resolved comments from the file
- **Auto-scroll**: Sidebar scrolls to the active comment automatically
- **Status footer**: Shows "X open · Y resolved" summary

### Viewing modes
- **Rendered view**: HTML-rendered markdown with comment highlights
- **Raw view**: Raw markdown with comment markers visible
- **Diff view**: Side-by-side diff comparing current content to a snapshot (take snapshot via toolbar)

### Review summary
- **Cross-file summary popover**: Shows all open files with comment counts per status
- **Aggregate stats**: Total comments, open, resolved across all tabs
- **Quick file jump**: Click a file in the summary to switch to it

### Navigation
- **Jump to next**: Press `N` or click toolbar button to focus next unresolved comment
- **Jump to previous**: Press `P` to focus previous unresolved comment
- **Click-to-select**: Click highlighted text in the viewer to activate the comment in the sidebar
- Comment cycling wraps around and skips resolved comments

### Themes
- **Light** — white/blue accent
- **Dark** — dark slate/indigo accent
- **Sepia** — warm brown/cream for reading comfort
- **Nord** — arctic color palette

Theme selection is persistent across sessions.

### Real-time file watching
- Detects external file changes via SSE (Server-Sent Events)
- Auto-reloads with toast notification when changes are detected
- Notifies specifically about resolved comments or new replies (useful when an AI agent edits the file)

### Session persistence
All of the following are saved to localStorage and restored on reload:
- Open tabs and active tab
- Sidebar visibility and active filter
- View mode (rendered/raw/diff)
- Recent files list
- Theme selection

### Keyboard shortcuts
| Shortcut | Action |
|---|---|
| `Cmd+Enter` | Submit comment / expand comment form |
| `Cmd+1-8` | Apply quick template 1-8 on selection |
| `Cmd+Shift+M` | Start commenting on selection |
| `Cmd+\` | Toggle sidebar |
| `N` | Jump to next unresolved comment |
| `P` | Jump to previous unresolved comment |
| `Escape` | Cancel comment form / unlock selection / cancel drag |

### Toast notifications
- Auto-dismiss after 5 seconds with fade animation
- Manual dismiss via close button
- Used for external change alerts (e.g., "Agent resolved N comments")

## Key design decisions

- Comments are stored in the markdown file itself (no sidecar files) so AI agents can read them with a simple file read
- Comment markers are placed **before** their anchor text — the marker's physical position in the file IS the comment's position, enabling precise matching and overlapping comments
- The `anchor` field stores the originally selected text for agent readability and as a fallback for re-matching
- Context before/after the anchor is stored for fuzzy re-matching when anchor text is edited
- Overlapping comments are allowed — multiple comments can reference overlapping text regions since each marker has a unique position
- `MarkdownViewer` uses ref-based innerHTML (not `dangerouslySetInnerHTML`) so React's reconciliation never interferes with highlight DOM modifications
- Comments have a `status` field (`open` | `resolved`) alongside the legacy `resolved` boolean for backward compatibility
- Comments support threaded replies via a `replies` array

## Known issues to fix

1. **Vite file watch** — Saving `.md` files in the project directory can trigger Vite reloads. The `vite.config.ts` has `watch.ignored: [/\.md$/]` but this doesn't fully suppress it.

## Comment format reference

Comment markers are placed **before** the text they refer to:

```
Some text <!-- @comment{"id":"uuid","anchor":"highlighted text","text":"comment text","author":"User","timestamp":"ISO-8601","resolved":false,"status":"open","replies":[]} -->highlighted text continues here.
```

- The marker sits immediately before the anchor text in the file
- `anchor` is the originally selected text — tells you what the comment refers to
- `text` is the reviewer's feedback
- `status` tracks the comment lifecycle: `open` or `resolved`
- `replies` is an array of `{id, text, author, timestamp}` objects for threaded discussion
- `resolved` is `true` when status is `resolved`, `false` otherwise (backward compat)
- Strip all `<!-- @comment{...} -->` markers to get the clean content
- The marker's position disambiguates when the same text appears multiple times

## Parser API

Key functions in `src/lib/comment-parser.ts`:
- `parseComments(raw)` — extract comments, return clean markdown + comment array
- `insertComment(raw, anchor, text, author?)` — add new comment
- `removeComment(raw, id)` — delete comment
- `setCommentStatus(raw, id, status)` — change status (also sets `resolved`)
- `editComment(raw, id, newText)` — update comment text
- `addReply(raw, id, text, author?)` — add threaded reply
- `resolveAllComments(raw)` — bulk resolve all open comments
- `removeResolvedComments(raw)` — delete all resolved comments
- `updateCommentAnchor(raw, id, newAnchor)` — change anchor text (drag-resize)
