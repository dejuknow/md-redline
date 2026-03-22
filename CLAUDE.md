# md-commenter

## What this project is

A local web app for adding inline review comments to markdown files. Think "Google Docs commenting" for `.md` files. The primary user is a product manager who generates specs/stories with AI tools and needs to leave feedback for the agent to address.

## How to run

```bash
npm install
npm run dev   # Starts Hono server (port 3001) + Vite dev server (port 5173)
```

## Architecture overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- **Backend**: Hono server at `server/index.ts` — exposes `/api/file` (GET/PUT), `/api/browse`, `/api/files`, `/api/config`
- **Markdown pipeline**: `src/markdown/pipeline.ts` — unified + remark-parse + remark-rehype + rehype-raw + rehype-stringify
- **Comment storage**: Inline comment markers in the `.md` file: `<!-- @comment{JSON} -->`
- **Comment parser**: `src/lib/comment-parser.ts` — extracts, inserts, removes, resolves, edits, replies, bulk operations on comments
- **Highlighting**: Done in `useLayoutEffect` inside `MarkdownViewer.tsx` using ref-based innerHTML (React never manages the container's children) + DOM manipulation (`surroundContents` with `extractContents` fallback). `React.memo` prevents unnecessary re-renders.

## Key design decisions

- Comments are stored in the markdown file itself (no sidecar files) so AI agents can read them with a simple file read
- Comment markers are placed **before** their anchor text — the marker's physical position in the file IS the comment's position, enabling precise matching and overlapping comments
- The `anchor` field stores the originally selected text for agent readability and as a fallback for re-matching
- Overlapping comments are allowed — multiple comments can reference overlapping text regions since each marker has a unique position
- `MarkdownViewer` uses ref-based innerHTML (not `dangerouslySetInnerHTML`) so React's reconciliation never interferes with highlight DOM modifications
- Comments have a `status` field (`open` | `addressed` | `accepted` | `reopened`) alongside the legacy `resolved` boolean for backward compatibility
- Comments support threaded replies via a `replies` array

## Comment statuses

- **open** — initial state when a comment is created
- **addressed** — the AI agent (or PM) has addressed the feedback, pending review
- **accepted** — the PM confirmed the fix (equivalent to old "resolved"). Highlights are hidden.
- **reopened** — the PM rejected the fix

Status transitions in the UI:
- Open/Reopened: Edit, Address, Resolve, Delete
- Addressed: Accept, Reopen, Delete
- Accepted: Reopen, Delete

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
- `status` tracks the comment lifecycle: `open` → `addressed` → `accepted` (or `reopened`)
- `replies` is an array of `{id, text, author, timestamp}` objects for threaded discussion
- `resolved` is `true` when status is `accepted`, `false` otherwise (backward compat)
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
- `removeResolvedComments(raw)` — delete all accepted comments
- `updateCommentAnchor(raw, id, newAnchor)` — change anchor text (drag-resize)
