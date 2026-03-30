# md-redline

See [README.md](./README.md) for features, usage, keyboard shortcuts, and CLI reference.

## Architecture internals

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- **Backend**: Hono server at `server/index.ts`
- **Markdown pipeline**: `src/markdown/pipeline.ts` — unified + remark-parse + remark-gfm + remark-frontmatter + remark-rehype + rehype-raw + rehype-sanitize + rehype-stringify
- **Mermaid rendering**: `src/lib/mermaid-renderer.ts` + `src/hooks/useMermaidRenderer.ts` — lazy-loaded, theme-aware SVG rendering of fenced `mermaid` code blocks
- **Comment storage**: Inline comment markers in the `.md` file: `<!-- @comment{JSON} -->`
- **Comment parser**: `src/lib/comment-parser.ts` — extracts, inserts, removes, edits, replies, bulk operations on comments
- **Highlighting**: Done in `useLayoutEffect` inside `MarkdownViewer.tsx` using ref-based innerHTML (React never manages the container's children) + DOM manipulation (`surroundContents` with `extractContents` fallback). `React.memo` prevents unnecessary re-renders.
- **CLI entry**: `bin/md-redline` — invoked as `mdr` (or `md-redline`), auto-starts the app and opens a file in the browser

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/config` | GET | Returns `initialFile` and `initialDir` from server startup |
| `/api/file?path=` | GET | Read a markdown file |
| `/api/file` | PUT | Write file content (`{path, content}`) |
| `/api/files?dir=` | GET | List all `.md` files in a directory |
| `/api/browse?dir=` | GET | List files and directories for the file browser |
| `/api/pick-file` | GET | Open native OS file picker dialog |
| `/api/watch?path=` | GET | SSE stream for external file changes |
| `/api/preferences` | GET | Read user preferences from `~/.md-redline.json` |
| `/api/preferences` | PUT | Merge-write user preferences |
| `/api/platform` | GET | Returns OS platform name |
| `/api/reveal` | POST | Reveal file in OS file manager |

Security: path validation against allowed roots, CORS restricted to localhost, 10 MB body limit.

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

13 fixtures: single-rewrite, mixed-statuses, overlapping-anchors, vague-comment, code-block, deletion-request, threaded-comments, large-file, no-comments, frontmatter, resolved-comments, clustered-paragraph, table-comments.

### Scoring dimensions

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| parsing | 25% | Were comment markers correctly removed after being addressed? |
| execution | 50% | Did content changes actually address the feedback? |
| integrity | 25% | Is the output valid markdown with no leftover malformed markers? |

Results are saved to `eval/results/<timestamp>_<agent>_<format>/` with per-case `scores.json` and a run-level `summary.json`.
