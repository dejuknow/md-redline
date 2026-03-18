# md-commenter

A local web app for reviewing and annotating markdown files with inline comments — like Google Docs commenting, but for `.md` files.

Built for product managers and anyone who uses AI tools (Claude Code, Copilot, etc.) to generate markdown specs, stories, and documentation, and needs a way to leave feedback directly on the generated content.

## How it works

1. Open any `.md` file on your local machine
2. Select text in the beautifully rendered markdown
3. Click "Comment" and type your feedback
4. Comments are stored as **HTML comments directly in the `.md` file** — no sidecar files

```markdown
The system supports email/password login<!-- @comment{"id":"...","anchor":"email/password login","text":"What about API key auth?","author":"User","timestamp":"2026-03-18T12:00:00Z","resolved":false} -->, OAuth 2.0...
```

Comments are invisible in standard markdown renderers (GitHub, VS Code preview, Zed) but fully readable by AI agents.

## Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and browse to a markdown file.

You can also pass a file path directly:

```bash
npm run dev:server -- /path/to/your/spec.md
```

## Using with AI agents

The comment format is designed to be consumed by AI agents like Claude Code. Add this to your `CLAUDE.md` or system prompt:

> When editing markdown files, look for `<!-- @comment{...} -->` markers. Each contains JSON with:
> - `anchor`: the text being commented on
> - `text`: the reviewer's feedback
>
> Address each comment by updating the document, then remove the comment marker once addressed.

The agent only needs the `anchor` and `text` fields. The `id`, `timestamp`, `author`, and `resolved` fields are for the UI.

## Architecture

```
├── server/           # Hono backend (file read/write API)
│   └── index.ts
├── src/
│   ├── App.tsx       # Main app: landing page + editor layout
│   ├── components/
│   │   ├── MarkdownViewer.tsx   # Renders markdown, applies highlights
│   │   ├── CommentSidebar.tsx   # Comment list panel
│   │   ├── CommentCard.tsx      # Individual comment display
│   │   ├── CommentForm.tsx      # Floating form for new comments
│   │   ├── FileBrowser.tsx      # Directory browser for opening files
│   │   └── Toolbar.tsx          # Top bar with file info and actions
│   ├── hooks/
│   │   ├── useFile.ts           # File load/save via API
│   │   └── useSelection.ts     # Text selection detection
│   ├── lib/
│   │   ├── comment-parser.ts    # Parse/insert/remove comments in markdown
│   │   └── selection-resolver.ts # DOM selection → text + context
│   └── markdown/
│       └── pipeline.ts          # unified/remark/rehype rendering pipeline
├── sample.md         # Example spec for testing
└── index.html        # Vite entry point
```

### Tech stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite 8
- **Markdown**: unified + remark-parse + remark-rehype + rehype-raw + rehype-stringify
- **Backend**: Hono + @hono/node-server (file I/O API)
- **Dev**: concurrently (runs Vite + Hono together)

### Comment storage format

Comments are HTML comments with a JSON payload, placed immediately after the anchor text:

```
<!-- @comment{"id":"uuid","anchor":"selected text","text":"reviewer comment","author":"User","timestamp":"ISO-8601","resolved":false} -->
```

This format:
- Is invisible in all standard markdown renderers
- Doesn't break markdown syntax
- Is trivially parseable by AI agents (just grep for `<!-- @comment`)
- Supports resolve/unresolve without removing the comment
- Needs no external database or sidecar files

## Known issues (MVP)

- **Highlight persistence**: Comment highlights may disappear after adding a new comment due to React's `dangerouslySetInnerHTML` reconciliation replacing the DOM. The highlights reappear when interacting with the viewer (e.g., selecting new text). This is the primary issue to fix in the next iteration.
- **Cross-element selections**: `surroundContents` fails when a selection spans across HTML element boundaries (e.g., selecting across bold/italic text). Only single-element selections are highlighted.
- **Duplicate anchor text**: If the same text appears multiple times, only the first occurrence gets highlighted.
- **Vite file watching**: Editing `.md` files inside the project directory may trigger Vite dev server reloads.

## Development

```bash
npm run dev          # Start both servers (Vite + Hono)
npm run dev:client   # Vite only
npm run dev:server   # Hono only
npm run build        # Production build
```

## License

MIT
