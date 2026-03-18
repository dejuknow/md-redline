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
- **Comment storage**: HTML comments embedded inline in the `.md` file: `<!-- @comment{JSON} -->`
- **Comment parser**: `src/lib/comment-parser.ts` — extracts, inserts, removes, resolves comments. Also provides a `cleanToRawOffset` mapping function.
- **Highlighting**: Done in `useLayoutEffect` inside `MarkdownViewer.tsx` using DOM manipulation (`surroundContents`). The component uses `dangerouslySetInnerHTML` for the markdown and `React.memo` to prevent unwanted re-renders.

## Key design decisions

- Comments are stored in the markdown file itself (no sidecar files) so AI agents can read them with a simple file read
- The `anchor` field stores the originally selected text for re-matching in the rendered output
- `insertComment` searches the CLEAN markdown (comments stripped) to avoid inserting inside existing comment markers, then maps back to raw offsets
- `MarkdownViewer` is wrapped in `React.memo` because `dangerouslySetInnerHTML` + `useLayoutEffect` DOM modifications create a fragile interaction where unrelated re-renders can destroy highlights

## Known issues to fix

1. **Highlight persistence after adding comments** — The primary open bug. After adding a new comment, existing comment highlights disappear from the viewer. Root cause: React's reconciliation detects that the DOM was modified by `useLayoutEffect` and replaces `innerHTML` on the next render, but the effect doesn't re-run because deps are unchanged. `React.memo` mitigates this for unrelated re-renders but doesn't fully solve it for all state-change paths. The proper fix likely involves either (a) moving away from `dangerouslySetInnerHTML` to a ref-based innerHTML approach, or (b) using `rehype-react` to render the markdown as React components with highlights built into the virtual DOM.

2. **Cross-element selection highlighting** — `surroundContents` throws when a selection spans element boundaries. Needs a text-node-walking approach.

3. **Vite file watch** — Saving `.md` files in the project directory can trigger Vite reloads. The `vite.config.ts` has `watch.ignored: [/\.md$/]` but this doesn't fully suppress it.

## Comment format reference

```
<!-- @comment{"id":"uuid","anchor":"selected text","text":"comment text","author":"User","timestamp":"ISO-8601","resolved":false} -->
```

When processing markdown files with comments, strip `<!-- @comment{...} -->` markers to get the clean content. The `anchor` field tells you what text the comment refers to. The `text` field is the reviewer's feedback.
