# md-redline

Use [README.md](./README.md) as the canonical product, usage, and feature reference.

**This is the single source of truth for agent-facing docs.** CLAUDE.md contains only
Claude-specific skill routing and points here. Do not duplicate content between the two files.

## Repo snapshot

- Local web app for inline review comments in markdown files
- Frontend: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- Backend: Hono server in `server/index.ts`
- CLI entry: `bin/md-redline`, exposed as `mdr` and `md-redline`

## Architecture overview

A Hono server serves both a Vite-built React SPA and a REST API.
An optional MCP stdio server lets AI agents request human review and wait for feedback.

### Directory layout

- `bin/md-redline` — CLI entry point (`mdr` command). Starts server, opens browser, handles `mdr mcp install`.
- `server/` — Hono app, routes, review session store, MCP stdio layer
- `src/` — React SPA (Vite + TypeScript + Tailwind)
- `src/lib/comment-parser.ts` — core parser for inline comment markers
- `src/lib/agent-prompts.ts` — prompt builder for agent handoff
- `e2e/` — Playwright E2E tests
- `eval/` — eval harness and fixtures

## Behavior that matters

- Comments are stored inline as `<!-- @comment{...} -->` markers immediately before their anchor text.
- Default workflow: comments are instructions to an agent, and addressed markers should be removed.
- Optional resolve workflow adds `open` / `resolved` status for human review.
- `MarkdownViewer.tsx` owns highlight DOM imperatively via refs; React does not reconcile the rendered markdown subtree.
- Overlapping comments are allowed and depend on marker position plus stored anchor/context for rematching.
- URL boot params: a `?file=` boot opens that file active on top of the restored tab session, and `?dir=` re-roots the explorer with tabs restored as saved; only `?review=` skips session restore.

## High-value files

- `server/index.ts`: file I/O API, preferences, native picker, SSE watch, reveal-in-file-manager
- `server/review-sessions.ts`: review session store (create, batch, finish, abort, heartbeat, sweep)
- `server/routes/review-sessions.ts`: HTTP routes for review session endpoints
- `server/mcp-stdio/`: MCP stdio server (handler, client, server, types, validate)
- `server/update-check.ts`: daily npm registry check for a newer published version, cached via preferences
- `bin/version-compare.js`: strict x.y.z version compare shared by the server's update checker and the CLI
- `src/lib/comment-parser.ts`: parse, insert, edit, delete, reply, resolve, anchor updates
- `src/markdown/pipeline.ts`: markdown -> sanitized HTML pipeline
- `src/components/MarkdownViewer.tsx`: rendered markdown, selection handling, highlight painting
- `src/components/RawView.tsx`: raw markdown view with syntax highlighting and diff overlay
- `src/components/RenderedDiffView.tsx`: rendered prose view of the diff overlay
- `src/components/ReviewBanner.tsx`: review session banner (send batch, finish, cancel)
- `src/components/PanelToolbar.tsx`: shared per-panel toolbar (search, view-mode, copy, handoff, diff controls)
- `src/components/Tooltip.tsx`: portal-based tooltip with snappy delay + scrubbing grace period
- `src/hooks/useComments.ts`: comment actions, handoff prompt generation, workflow logic
- `src/hooks/useReviewSession.ts`: polling and heartbeat for active review sessions
- `src/hooks/useDiffLines.ts`: single source of diff state shared by raw view, rendered view, and the toolbar badge
- `bin/md-redline`: auto-start CLI and browser opener
- `eval/runner.ts`: eval harness; default adapter is currently `claude-cli`

## Comment format

Markers sit immediately **before** the anchor text they refer to:

```
Some text <!-- @comment{"id":"uuid","anchor":"highlighted text","text":"comment body","author":"User","timestamp":"ISO-8601","status":"open","replies":[{"id":"uuid","text":"reply","author":"User","timestamp":"ISO-8601"}]} -->highlighted text continues here.
```

- `anchor` — the originally selected text (what the comment refers to)
- `text` — the reviewer's feedback
- `replies` — threaded discussion array
- `status` — `open` or `resolved` (only present when resolve workflow is enabled); a comment is considered an **orphan** when its `anchor` text can no longer be located in the current document
- `contextBefore` / `contextAfter` — surrounding text for fuzzy re-matching when anchor is edited
- `agentInitiated` — `true` when the marker was created by an agent (via `mdr_ask` or `mdr_review`).
- `expectsReply` — `true` while an `mdr_ask` question is awaiting the user's answer. Cleared when the user replies (addReply/appendReply), when the session ends (End review / Finish review), or by the stranded-marker sweep after a server restart. A marker with `agentInitiated: true` but no `expectsReply` is "asked, closed": a record, not a pending question.
- `sessionId` — links an agent-initiated marker to a review session for reply routing.
- Strip all `<!-- @comment{...} -->` markers to get clean content
- Marker position disambiguates when the same text appears multiple times

## API endpoints

**Files**
- `GET /api/file?path=` — read markdown file
- `PUT /api/file` — write markdown file (supports optimistic concurrency via `expectedMtime`)
- `GET /api/files?dir=` — list markdown files in a directory
- `GET /api/browse?dir=` — browse directory structure (files + folders)
- `GET /api/asset?path=` — serve image assets (PNG, JPG, SVG, etc.)
- `GET /api/watch?path=` — SSE stream of external file changes
- `GET /api/pick-file` — native file picker (macOS/Linux/Windows)
- `GET /api/pick-folder` — native folder picker

**Review sessions**
- `POST /api/review-sessions` — create a session (`{ filePaths, enableResolve?, origin?: 'user' | 'agent', clientId? }`). `origin` defaults to `'user'`; the `mdr_review` MCP tool passes `'agent'` to enable agent-specific banner states and GC behavior. `clientId` is an opaque caller identity (the MCP client sends a process-scoped UUID) that scopes dedupe: two different agents on the same files get distinct sessions, while the same agent batching successive calls reuses its own.
- `GET /api/review-sessions` — list open sessions
- `GET /api/review-sessions/:id` — get session details
- `POST /api/review-sessions/:id/batch` — send a batch of comments to the waiting agent
- `POST /api/review-sessions/:id/finish` — send final batch and close session. Pending asks do not block finish: inline replies found in the markers are delivered to the agent first, and remaining unanswered asks close as `done_without_reply` with their markers preserved (flags cleared).
- `POST /api/review-sessions/:id/abort` — cancel session
- `POST /api/review-sessions/:id/heartbeat` — keep session alive (browser sends every 10s)
- `GET /api/review-sessions/:id/wait` — long-poll for the user-batch flow; agent blocks here until a batch or finish arrives. 409 on agent-origin sessions (use `/agent-wait`). Optional `?timeout=<seconds>` returns `{ status: 'pending' }` for re-polling clients.
- `GET /api/review-sessions/:id/agent-wait` — long-poll for agent-origin sessions; resolves when the user clicks End review (`{ status: 'done' }`) or the session ends another way (`{ status: 'aborted', reason }`). Same `?timeout` contract as `/wait`. Backs the `mdr_wait` tool.
- `POST /api/review-sessions/:id/agent-done` — the End review click. Delivers any inline replies sitting in the markers to a pending ask (partial delivery allowed), clears `expectsReply` on unanswered markers, then resolves the agent's `/agent-wait`. 409 on user-origin sessions.
- `POST /api/review-sessions/:id/agent-comments` — agent posts comments and/or replies.
  Body accepts:
  - `mode: 'ask' | 'review'` — explicit intent. Without it, mode is inferred from shape (`questions[]` alone → ask; `comments[]` alone → review); contradictory combinations are rejected with specific 400s.
  - `comments[]` (review mode) or `questions[]` (ask mode) — top-level anchored comments
  - `replies[]` — `{ filePath, commentId, text }` objects to append to existing comments (review mode)
  - Ask mode works on BOTH session origins; asking about the user's own review comments (a `mdr_request_review` handoff) is the flagship case.
  - Length caps enforced server-side: anchor and context 8 KB, text 64 KB.
  Response includes `failedComments[]` and `failedReplies[]`.
- `GET /api/review-sessions/:id/asks/:askId/wait` — agent long-polls for the user's reply
- `POST /api/review-sessions/:id/asks/:askId/reply` — structured reply channel; resolves the ask. The web UI no longer uses it (users reply inline on the comment card; the file-save sweep resolves the ask), but it remains for programmatic callers.
- `POST /api/review-sessions/:id/asks/:askId/release` — resolve the ask with `{ status: 'no_reply', reason: 'released' }`. Only producer today is the agent's own tool-call cancellation (no UI button).
- `GET /api/review-sessions/:id/asks` — list pending asks for the session

**Inline reply delivery** — when the user answers an agent question by replying on
the comment card, the reply is stored inside the marker and saved via `PUT
/api/file`. The save handler sweeps pending asks: an ask whose every question now
has a reply resolves immediately (the agent unblocks without any End review
click). Partially answered asks stay pending until End review / Finish review,
which deliver whatever replies exist.

**Restart recovery** — sessions and asks are memory-only; markers persist on
disk. `GET /api/file` sweeps markers whose `expectsReply` flag references a
session that is no longer open and clears the flag (marker preserved). A
post-restart `mdr_wait` on an unknown session gets a graceful "re-read the
file(s)" result instead of an error.

**Config and system**
- `GET /api/config` — initial file, directory, home dir
- `GET /api/version`: `{ version, latest?, updateCheckPending? }`; `latest` is
  present only when the update checker knows a published version strictly
  newer than `version`; `updateCheckPending: true` is present only while the
  checker's registry fetch is in flight (see Update checks below)
- `GET /api/platform` — OS platform
- `GET /api/preferences` / `PUT /api/preferences` — user preferences, persisted
  to `~/.md-redline.json`. The server whitelist (`SETTING_SANITIZERS` in
  `server/preferences.ts`) is a mapped type over the client `AppSettings`
  (`src/lib/settings.ts`), so adding a settings field on the client without a
  server sanitizer is a compile error. To add a setting: add the field plus
  default to `src/lib/settings.ts` (`AppSettings`, `DEFAULT_SETTINGS`,
  `parseSettings`), then add its one-line sanitizer to `SETTING_SANITIZERS`.
  A round-trip test in `server/preferences.test.ts` backstops the whitelist.
  Two keys sit outside that whitelist: `updateCheck` (`{ latestKnown,
  checkedAt }`) is the server-owned npm registry cache, written only by the
  update checker, and `PUT /api/preferences` strips it from any client body;
  `updateDismissedVersion` is the viewer's per-version dismissal of the
  update notice and is written by the client like any other setting.
- `POST /api/grant-access` — grant filesystem access to a new path
- `POST /api/reveal` — open file location in OS file explorer
- `POST /api/shutdown` — graceful server shutdown
- `GET /__mdr__` — health check

Security defaults in `server/index.ts`: path validation against allowed roots, localhost-only CORS, 10 MB body limit.

**Ports and loopback discipline** — the API server binds IPv4 loopback only
(`127.0.0.1`), default port 6373 ("MDR" on a phone keypad; overridable via
`MD_REDLINE_PORT`), scanning up to 10 ports from there if taken. The Vite dev
client uses 5188 (`MD_REDLINE_VITE_PORT`), same scan. The CLI (`bin/md-redline`)
probes, kills, and opens browser URLs with `127.0.0.1`, never `localhost`:
`localhost` resolves to `::1` first, so when another app holds the same port
number on IPv6 (Next.js/Nest commonly squat 3000-3010), a localhost probe
reaches that app and the CLI goes blind to its own healthy server. The CLI also
scans the legacy 3001-3010 range so it can find, upgrade, or stop pre-6373
servers. The server records its port in `$TMPDIR/md-redline.port` for the CLI's
fast-path lookup and removes it on exit only if it still owns the recorded port
(`removePortFileIfOwned`).

**Browser launcher** — the CLI opens the resolved URL in the OS default
browser: `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows). Set
`MDR_BROWSER` to override with an explicit command that is spawned with the URL
as its argument. Every launch goes through `spawnDetached`, which on Windows
must pass `detached: true` (opt-in per call) so the child outlives the CLI's
near-immediate exit; without it the launcher is torn down before it runs. The
long-lived server deliberately stays non-detached, since a detached child gets
its own console window on Windows that `windowsHide` cannot suppress under
`shell: true`. The undocumented `mdr __open <url>` subcommand runs only the
launcher and exits; the browser-open regression test
(`bin/open-launch-cli.test.ts`) drives it with `MDR_BROWSER` pointed at a stub.

**CLI stale-server upgrade**: on every plain `mdr` invocation,
`ensureServerRunning()` in `bin/md-redline` asks the running server for
`GET /api/version` and compares it to the CLI's own version (read from the
`package.json` next to the installed bin). On any mismatch it prints
`Upgrading mdr <old> → <new>...`, gracefully shuts the old server down
(`POST /api/shutdown` via `gracefulShutdown`, falling back to a port kill),
and respawns from the code on disk. Nothing is downloaded here:
`npm install -g md-redline@latest` (or a version bump in a linked dev repo)
is what puts new code on disk; this path only stops the long-lived background
server from serving stale code after that has happened.

**Update checks**: `server/update-check.ts` checks
`<registry>/-/package/md-redline/dist-tags` once a day, from the server, never
blocking startup or a request. The registry defaults to
`https://registry.npmjs.org`, overridable via `MD_REDLINE_REGISTRY_URL`. A
strictly-newer published version is compared with `isNewerVersion` in
`bin/version-compare.js` (strict `x.y.z` compare; prerelease or malformed
versions never trigger a notice) and cached as `updateCheck` in
`~/.md-redline.json` (see `PUT /api/preferences` above). Presence of
`NO_UPDATE_NOTIFIER` or `CI` (any value, including empty) in the server
process's environment disables the checker entirely. The CLI performs no env
check of its own: it only relays whatever `latest` the running server's
`GET /api/version` reports, so suppression follows the environment the server
was started with, not the shell running `mdr`. `updateCheckPending` on that
endpoint is true while a registry fetch is in flight (always at boot until
the first check resolves or a fresh cache is read; absent when the checker is
disabled). After opening the browser, the CLI polls the endpoint for up to
6 seconds while the flag is set (`waitForUpdateCheck`), so a just-started
server's first check can land before the CLI decides whether to print the
terminal update notice.

## MCP stdio server

The MCP server exposes four tools.

**`mdr_request_review`** — An AI agent calls it with `{ filePaths, enableResolve? }` to
create a user-initiated review session. The server opens the browser with
`?review=<sessionId>`, and the tool long-polls `/wait` (90s re-poll cycle; pass the
returned sessionId back to continue) until the human sends batches or finishes. Each
batch returns `{ status: 'batch', prompt, commentIds }`; finish returns
`{ status: 'done', prompt?, commentIds? }`.

**`mdr_ask`** — Called with
`{ sessionId, questions: [{ filePath, anchor, text, author?, contextBefore?, contextAfter? }] }`
to post anchored questions to the user mid-task. Works on BOTH session origins; the
flagship case is asking a clarifying question about the user's review comments using
the sessionId from a `mdr_request_review` handoff. Question markers are inserted with
`agentInitiated: true`, `expectsReply: true`, and `sessionId`. The tool returns:

- with the reply text the moment the user has answered every question inline
  (the file-save sweep resolves the ask; no End review click needed), or
- with whatever partial replies exist when the user clicks End review / Finish
  review, or
- empty-handed (`no_reply` + reason) when the session ends another way.

Answered markers keep the question and the reply as a thread; unanswered markers
are preserved with `expectsReply` cleared (a record of "asked, no answer").
Only one ask can be pending per session at a time.

**`mdr_review`** — Agent-initiated review; the reverse direction of
`mdr_request_review`. The agent calls it with:

```ts
{
  filePaths: string[]            // required; absolute paths, length >= 1
  comments?: Array<{             // new top-level comments
    filePath: string             // must appear in filePaths[]
    anchor: string               // exact text in the file
    text: string                 // the feedback
    author?: string              // agent name shown in the UI
    contextBefore?: string
    contextAfter?: string
  }>
  replies?: Array<{              // replies to existing comments
    filePath: string
    commentId: string            // existing top-level comment id
    text: string
    author?: string
  }>
  enableResolve?: boolean
}
```

At least one of `comments[]` or `replies[]` must be non-empty. The tool opens the
browser at the session URL (`origin: 'agent'`), writes the markers, and returns
IMMEDIATELY (fire-and-forget). The result instructs the agent to call `mdr_wait`
with the returned sessionId. Partial-anchor failures are surfaced as
`failedComments[]` / `failedReplies[]`, and a failed multi-file batch rolls back
the markers it already wrote.

**`mdr_wait`** — `{ sessionId }`. Blocks (90s re-poll cycle via `/agent-wait`)
until the user clicks End review. Returns "done, re-read the file(s)" on End
review, a reason-specific message on other terminal paths (cancelled, tab closed,
agent_silent GC, finished), `pending` when the agent should re-poll, and a
graceful "session unknown, server may have restarted" result on 404. The two-tool
flow is always: `mdr_review` (post) → `mdr_wait` (block).

Server-side GC: if a session has `origin='agent'` and no comments are posted within
5 minutes with no MCP heartbeat, the session is aborted with `reason='agent_silent'`.

The `AskWaitResult` type returned by `mdr_ask`'s wait:

```ts
type AskWaitResult =
  | { status: 'reply'; replies: Array<{ questionIndex: number; text: string }>; totalQuestions: number }
  | { status: 'no_reply'; reason: 'released' | 'tab_closed' | 'cancelled' | 'done_without_reply' | 'timeout' | 'agent_silent' }
```

`no_reply` reasons: `released` = the agent cancelled its own tool call (no UI
button produces this); `tab_closed` = browser disconnected; `cancelled` = user
cancelled the review; `done_without_reply` = user clicked End review / Finish
review without answering; `timeout` = session aged out; `agent_silent` = agent
created a session but never posted comments (server GC fired). Comments already
written persist in the file; every reason except `agent_silent` tells the agent
to re-read the file(s) since the user may have replied inline or edited the doc.

Install commands:
- `mdr mcp install` — install for Claude Code (writes to `.mcp.json`)
- `mdr mcp install --claude-desktop` — install for Claude Desktop
- `mdr mcp install --claude-code` — explicit Claude Code install

Session lifecycle: browser heartbeats every 10s. Server sweeps abandoned sessions
after 30s without a heartbeat. If the agent is waiting and the browser disconnects,
the server waits 60s before clearing `waitingForAgent`.

## UI features

### Title row
The toolbar and the tab bar share one 44px row (`h-11`) instead of stacking as two
separate rows. The app icon still anchors the left side, but the "md-redline"
wordmark text next to it was dropped to make room; tabs render inline via
`TabBar`'s `embedded` mode in the row's flexible middle section, with the settings
button and the rest of the toolbar controls on the same baseline. Below it, the
per-panel toolbar (`PanelToolbar.tsx`: search, view-mode, diff controls) is a
slimmer 2rem strip.

### Review banner
When a review session is active, a sticky banner appears at the top with one row
per session:

- **User-initiated** (`origin='user'`): "Agent is waiting on your review of file.md".
  Three actions: **Send N comments** (send current batch, keep session open), **Send N &
  finish** / **Finish review** (send and close), **Cancel review** (link style). Sent
  comments get a dimmed "Sent" badge on their card. If an agent asks a question
  mid-handoff, a warning-palette chip appears: "N questions awaiting your reply",
  clickable to jump to the first question card.
- **Agent is reviewing** (`origin='agent'`, no pending questions): "{Agent} is reviewing
  file.md" with a spinner while the agent is active (including just-started sessions
  with no posts yet) and a static dot once the agent has been quiet for 30s. Shows
  the comment count in parentheses. Single action: **End review**.
- **Awaiting your reply** (`origin='agent'`, pending `mdr_ask` questions): the row
  switches to "{Agent} is waiting on your reply." with a pulsing warning dot and the
  question-count chip (click to jump). **End review** stays available but asks for
  confirmation: unanswered questions are reported back to the agent as unanswered.

**End review** posts to `/agent-done`: inline replies in the markers are delivered
to the agent, the session closes, and the banner clears. The agent's name comes
from the first agent-initiated comment's author, falling back to "Agent".

The browser tab title reflects the active file as "{filename} · md-redline" (just
"md-redline" when no file is open), so multiple md-redline tabs are distinguishable.
When a new agent question arrives, a toast fires ("{Agent} has a question on
file.md") with a **View** action that jumps to the card, and the tab title gains a
"(N questions)" prefix until all questions are answered.

### Selection pill
Selecting text in the rendered view shows a compact pill near the selection instead
of the full comment form. The pill has a **Comment** button, one button per each of
the first two templates from Settings for one-tap prefill, and a **More templates**
kebab when more than two templates are configured. The kebab expands an in-place
menu (`data-pill-template-menu`) listing the remaining templates; picking one
behaves like the inline one-tap buttons (prefills the form). Clicking **Comment**
or any template opens the full form with the template grid hidden; the footer's
"Quick templates" toggle still opens the grid on demand. The pill follows its
selection while the document scrolls (live DOM selection when available, a
scroll-delta fallback for locked selections) and hides while the selected text is
off-screen. The **Quick comment** setting skips the pill entirely and opens the
full form immediately on selection, as before. The pill's width is capped to
`calc(100vw - 24px)` so it never overflows on narrow windows, and its buttons
show a crimson focus-visible ring on keyboard focus.

While a template prefill sits untouched in the full comment form, Escape
clears the prefill and keeps the form open; a second Escape (or an Escape
after typing) closes the form as usual.

### Comments rail
The single comment surface for the rendered view: a fixed-width column at the
right edge of the document page, inside the same width-managed page unit as
the prose column (`src/lib/page-geometry.ts`, `CommentsRail.tsx`). Two
densities, switched via the segmented control (`RailDensityControl`,
`[data-rail-header]`) that renders in the panel toolbar's right group while
the rail is shown (a header inside the rail occluded the anchored cards), and
persisted per-user (see below). Each density segment shows a crimson
focus-visible ring on keyboard focus. Tab badges count ALL open comments including
agent-initiated ones (`tabCommentCounts` in App); the handoff button keeps
the sendable-only map. Inline code in prose renders neutral (`--theme-text`
on `--theme-bg-inset`), never the crimson accent:

- **Anchored** (default): cards align to their document anchors. Cards are
  compact by default (anchor text, comment preview, reply count); the active
  card (selected by clicking its highlight or the card itself) expands to the
  full thread view with all actions, including Reply. A connector line runs
  from the anchor to the active (or hovered) card along the rail's left edge.
  Cards never overlap: they resolve top-down by anchor position, and the
  active card gets priority to sit at its anchor, compressing cards above it
  upward when needed, capped at `MAX_LIFT` (96px) above each card's own
  anchor (`src/lib/margin-layout.ts`); past the cap the active card shifts
  down by the residual instead of lifting other cards further. Comments
  whose anchor text can't be found in the document (orphans) stack in a
  block at the top of the rail, above the
  anchored cards. Resolved comments do not appear in this density at all;
  they stay in List density's / the drawer's Resolved filter. Geometry comes
  from `useMarginLayout`; card and connector position changes animate over
  150ms via `.margin-note-pos`, disabled under `prefers-reduced-motion`.
- **List**: a pinned instance of `CommentListSurface`, with full search, status
  filter (All / Open / Resolved), sort, and bulk actions. Filters and search
  share a single header row (search input placeholder is "Search"). The same
  component backs the comments drawer (below), so behavior is identical in
  both places.

**Geometry and thresholds** (`src/lib/page-geometry.ts`): `PAD_L` 48,
`COL_MAX` 672, `COL_MIN` 480, `GAP` 56 (rail-to-column gutter), `RAIL` 280,
`PAD_R` 24. The prose column shrinks continuously from `COL_MAX` down to
`COL_MIN` before the rail gives up; showing the rail needs at least 888px of
content width (`COL_MIN + GAP + RAIL + PAD_R + PAD_L`). The page's overall
width caps at 1080px with the rail shown (`PAD_L + COL_MAX + GAP + RAIL +
PAD_R`) and 768px without it (`PAD_L + COL_MAX + PAD_L`).

**Persistence**: `railDensity` and `sidebarVisible` (the user's rail-visibility
preference; the key name predates the rail and is unchanged for backward
compatibility with existing `localStorage`) live in the `md-redline-pane-layout`
key alongside the rest of the pane layout state.

**When the rail can't show**, meaning raw view, an active diff overlay, a
rendered view narrower than the 888px threshold, the user has hidden it, or
focus mode is active, two fallback surfaces take over (there is deliberately
ONE entry point for comments: the toolbar comments button / `Cmd+\`, which
opens the rail where it fits and the drawer everywhere else):

- **Comments drawer** (`CommentsDrawer.tsx`, `data-comments-drawer`): a
  right-side overlay hosting `CommentListSurface`, opened by the toolbar
  comments button or `Cmd+\` when the rail can't fit. Closes automatically
  once the rail becomes available again, so the two surfaces never show at
  once. (An earlier bottom-right FAB duplicated this entry point and was
  removed.)
- **Comment popover** (`CommentPopover.tsx`, `data-comment-popover`): a
  single-thread surface positioned under the clicked highlight, page-relative
  so it scrolls with the text. Opens when a highlight is clicked (or a new
  comment created) while the rail is hidden and the drawer is closed; the
  drawer's own focus-forwarding takes priority when the drawer is already
  open. Closes on Escape, an outside click, the rail becoming available, or
  the active file changing.

Every comment focus request (jump-to-next/prev, agent-ask navigation, toast
actions, palette commands) is guaranteed to reach one of these surfaces, rail,
drawer, or popover: never a dead click. Each request carries an origin,
`'creation'` or `'jump'` (the default set by `requestCommentFocus`). In
Anchored density a `'creation'` request (a just-added comment, from
`handleAddComment` in `useComments.ts`) is consumed without activating the
card, so the anchored stack stays put instead of pinning and shoving cards
around the new comment; jump-to-ask, palette jumps, and the review banner's
View action all use the `'jump'` origin and still activate and scroll to the
card. Creating a comment while the rail is hidden still opens the popover
regardless of origin.

**`Cmd+\`** toggles the rail where it fits in the current rendered view;
otherwise it toggles the drawer, since that's the only comment surface left.
This check only looks at width/view-mode (`geometry.railFits`), not whether
the rail is currently allowed to show. So in focus mode on a narrow window,
`Cmd+\` opens the drawer instead of exiting focus mode (see Focus mode below).

**Filter auto-widen**: activating a comment (via highlight click, jump
navigation, or an agent-ask notification) that List density's / the drawer's
current status filter or search query would otherwise hide clears whichever
one is hiding it, so the newly active comment's card is visible. Implemented
once in `CommentListSurface`, shared by both surfaces.

#### Needs re-anchoring
When a comment's anchor text can no longer be found in the document (e.g. after an
agent rewrites the surrounding paragraph), the comment becomes an **orphan**. In
List density and the drawer, orphans appear in a dedicated "Needs re-anchoring (N)"
section at the top of `CommentListSurface`, above the normal comment list; in
Anchored density they stack at the top of the rail (see above). Each card shows
the stored anchor text and surrounding context, plus a **Re-anchor to selection**
button. To re-anchor: select replacement text in the viewer, then click the
button. This calls `moveComment` under the hood and restores the comment at the
new position. When comments first become orphaned, a debounced toast fires after
500 ms: `"N comment(s) lost their anchor. See "Needs re-anchoring" in Comments."`

#### Agent questions
When the agent calls `mdr_ask`, the questions render as standard comment cards
(agent name in the author field) in whichever surface is currently active. Reply
on the card like any other comment: the reply is stored in the marker, and as
soon as every question in the ask has a reply the agent unblocks with the reply
text, no extra send step needed. The banner chip, the toast's View action, and the
palette command all jump to pending question cards, routed through the same
focus-request plumbing described above so they always land on a visible surface.
Ending the review with unanswered questions (after the confirm dialog) reports
them back to the agent as unanswered and keeps the markers as a record with
`expectsReply` cleared.

### Density strip
A thin overview ruler (`data-density-strip`) pinned to the document panel's right
edge, with one tick (`data-tick-id`) per anchored comment at its proportional
scroll position. Ticks are 4px tall (`h-1`) and scale up on hover. Tick color
signals kind: the theme accent color for an agent's open `mdr_ask` question,
the theme success color for a resolved comment, and the standard
comment-underline color for a regular open comment. Each tick's title tooltip
is author-prefixed: `"{author}: {first 60 characters of the comment text}"`.
Clicking a tick jumps to and activates that comment's anchor, the same as
clicking it from the rail or drawer. Hidden when there are no anchored
comments, in raw view, or while the diff overlay is showing.

### Section breadcrumb
An inline breadcrumb (`data-section-breadcrumb`) rendered in the panel
toolbar's middle slot (the `breadcrumb` prop on `PanelToolbar`) once the
reader scrolls past the document's first heading. It names the current section
by its full heading chain (e.g. "Requirements > Functional Requirements"),
truncating each segment past 28 characters. Each segment is a button that
jumps to that heading. Hidden in raw view and while the diff overlay is
showing, and disappears again once scrolled back above the first heading.

### Diff overlay
After a review handoff, a diff overlay shows what changed since the handoff,
available in both rendered and raw views via the panel toolbar. The handoff
captures a **diff reference** per file (`{ content, capturedAt, origin }`,
persisted in `localStorage` under `md-redline-snapshots`; legacy bare-string
values are migrated on load). The change set is computed by `useDiffLines`
(`diffChunkCount` is the number of changed chunks). The reference is
auto-managed as a "review frontier":

- The diff toggle is quiet (no active styling, no count badge) when
  `diffChunkCount` is 0, and switching to raw view auto-opens the overlay only
  when there are changes to show.
- While the overlay is open on a non-empty diff, a label states what is being
  compared, e.g. "Since last handoff, 3:14 PM" or "Since last review, ..."
  (from the reference `origin` + `capturedAt`, via `formatReferenceLabel`).
- **Auto-advance**: when the active file's open-comment count crosses to zero
  (gated on `enableResolve`), the reference advances to the current content, the
  diff resets, and a toast ("All comments resolved. Diff reset.") offers Undo.
  Guarded against spurious advances on tab switch, Undo, and `enableResolve`
  toggles (`shouldAdvanceFrontier` plus the `prevOpenCount` /
  `advancedForEpisode` / `frontierFile` / `prevResolveEnabled` refs in `App.tsx`).
- **Mark reviewed** (panel toolbar text button + command palette, shown only
  when `diffChunkCount > 0`) manually advances the reference to the current
  content, also with an Undo toast.

Reference store + migration live in `src/hooks/useDiffSnapshot.ts`; the pure
advance decision and label formatter in `src/lib/review-frontier.ts`.

### Raw view comment markers
Comment markers in raw view fold to a one-line pill by default: author plus
the first words of the comment (`.raw-marker-pill`). The full marker JSON
(`.raw-marker-json`) stays hidden until the marker is clicked, then renders
de-emphasized (muted, italic) instead of as highlighted content. Click again
to fold it back. Fold state is tracked per marker id in `RawView`
(`expandedMarkerIds`) and re-applied after each re-render, since folded is
the default baked into the generated HTML. The active-comment highlight and
the scroll-to jump flash still target the marker span itself, so both keep
working regardless of fold state.

### Mermaid fullscreen view
Click the expand button (top-right of any Mermaid diagram on hover) to open the
diagram in a fullscreen modal with pan/zoom and a docked comment panel. The modal
preserves full commenting parity (read, create, reply, resolve).

### Inline editing
A per-document Edit toggle on the content-area toolbar (`E`, or the pencil
button, rendered view only; default off). When on, clicking a block opens it in
place in a CodeMirror 6 live-preview editor: markdown syntax is hidden off the
active line, `<!-- @comment -->` markers render as atomic read-only chips, and
the rest of the document stays rendered. Commit on blur or `Cmd+Enter`, cancel
with `Esc`. Commit splices the edited source slice back into the raw markdown and
autosaves via `PUT /api/file` with optimistic concurrency, so comment anchors
re-match (or surface in "Needs re-anchoring") exactly as after an agent rewrite.

Architecture: `src/markdown/stampSourcePositions.ts` stamps `data-src-start`/
`data-src-end` (clean-markdown offsets) on block elements; `parseComments` exposes
`cleanToRawOffset` / `rawToCleanOffset` to bridge clean and raw space;
`src/editor/blockSlice.ts` maps a clicked block's clean range to its raw slice and
splices commits back; `src/editor/BlockEditor.tsx` hosts the CM6 view (live-preview
in `livePreview.ts`, marker chips in `markerChips.ts`). `MarkdownViewer` suspends
its imperative DOM rebuild while a block is open and portals the editor into an
in-flow host beside the hidden block(s). Code fences, tables, and Mermaid
diagrams edit as source text (the rendered Mermaid block carries the source
offsets, so clicking the diagram opens its ```mermaid``` source; the fullscreen
button still works in edit mode). Frontmatter is not rendered, so it has no
inline edit target (edit it via the raw view).

Cross-block editing: the editable unit is a source range that can grow. Backspace
at the block start merges the previous block (Delete at the end merges the next):
the neighbor's source joins the live editor content with the separator dropped,
and the editor remounts (a bumped `editorKey`) with the cursor at the join.
Drag-selecting across two or more blocks opens the editor over their union. The
host effect hides every outermost stamped block in the range, so a multi-block
range collapses to one editor. Clicking places the cursor where you click
(`sliceOffsetForClick` maps the rendered caret through plain -> clean -> raw).

External changes while a block is open are held (not reloaded under the cursor):
`MarkdownViewer` reports open/closed via `onEditingChange`, and `onExternalChange`
stashes the change and shows a "changed on disk" banner with a Reload action
instead of reloading. The pending edit's save keeps the un-bumped mtime, so a real
conflict still 409s; Reload discards the open edit and loads the disk content.

### Left sidebar (full height)
The sidebar owns the window's full left edge, top to bottom; the chrome row
(tabs, author, comments toggle) starts to its right. Two states:

- **Expanded panel** (`[data-sidebar-panel]`, resizable): logo + close X in an
  h-11 identity row (aligns with the chrome row), Explorer/Outline view tabs
  below it, panel content, and the settings gear pinned in a bottom row.
- **Collapsed icon rail** (`[data-sidebar-rail]`, 40px): logo on top, Show
  Explorer and Show Outline icon buttons, spacer, settings gear at the
  bottom. Clicking an icon expands the panel to that view.

There is no explorer toggle in the toolbar anymore; `Cmd+B` still toggles
(rail <-> panel), and the whole sidebar (rail included) hides in focus mode.
The app logo and the settings gear live only in the sidebar.

### File explorer
Sidebar view (`Cmd+B`) for browsing and opening markdown files.

### Document outline
Sidebar view (`Cmd+Shift+O`) showing heading structure for quick navigation.

### Focus mode
`Cmd+.` toggles focus mode: the file explorer and the comments rail both hide
(their prior visibility is snapshotted first), leaving just the document. A
"Focus" status chip (`data-focus-chip`) appears in the bottom hint bar; click
it, or press `Cmd+.` again, to exit and restore the panes to their snapshotted
state. The density strip and section breadcrumb both stay available in focus
mode. Toggling
the explorer or the rail individually while focus mode is active (`Cmd+B`,
`Cmd+\`, the comments toolbar button, or the command palette) exits focus mode and
restores the snapshot instead of performing their normal toggle, with one
exception: on a window too narrow for the rail to fit at all, `Cmd+\` opens
the comments drawer instead of exiting focus mode, since that check only
looks at width and doesn't know about focus mode (see Comments rail above).

Known edge: focus mode itself is session-only state and isn't persisted, but the
pane visibility it changes is (via the pane layout `localStorage` key). Quitting
while focus mode is active leaves both panes hidden the next time the app opens,
with no focus chip present to explain why or restore them. Toggle the explorer
(`Cmd+B`) and rail (`Cmd+\`) back on individually to recover.

### Keyboard shortcuts

| Keys | Action |
|------|--------|
| `E` | Toggle inline edit mode (rendered view) |
| `N` / `J` | Next comment |
| `P` / `K` | Previous comment |
| `Cmd+Enter` | Start commenting on selection (or commit the open block when editing) |
| `Cmd+Shift+M` | Lock selection for commenting |
| `D` | Delete active comment |
| `A` / `X` | Resolve active comment |
| `U` | Reopen active comment |
| `Cmd+F` | Find in document |
| `Cmd+K` | Command palette |
| `Cmd+\` | Toggle comments rail (drawer when the rail can't fit) |
| `Cmd+B` | Toggle file explorer |
| `Cmd+Shift+O` | Toggle document outline |
| `Cmd+.` | Toggle focus mode |
| `Cmd+O` | Open file |
| `Cmd+,` | Open settings |
| `Cmd+Shift+[` / `]` | Previous / next tab |
| `?` | Keyboard shortcuts help |
| `Esc` | Close fullscreen modal (Mermaid diagrams) |
| `+` / `-` | Zoom in / out (Mermaid fullscreen) |
| `0` | Fit to screen (Mermaid fullscreen) |
| Arrow keys | Pan diagram (Mermaid fullscreen) |

### Settings panel

- **Author name** — name attached to comments and replies
- **Enable resolve workflow** — adds resolve/reopen actions (off for AI agent workflows)
- **Quick comment**: skip the selection pill and open the comment form immediately on text selection
- **Comment max length** — character limit per comment (long markers confuse AI parsers)
- **Show templates by default** — when Quick comment opens the form immediately, also show the template picker. When the selection pill is used, the form opens with the grid hidden; toggle it with the footer button to show templates.
- **Templates** — customizable comment templates
- **Mermaid fullscreen panel collapsed** — start with comment panel closed in fullscreen view
- **Prose typeface**: `'serif'` or `'sans'`, default `'serif'`. Controls the rendered document body font (`[data-prose-font]` attribute plus `.prose` font-family in `src/index.css`). Set from the General tab.
- **Document width**: `'narrow' | 'default' | 'wide'` (520/672/860px column caps, `DOC_WIDTH_COLS` in `src/lib/page-geometry.ts`), default `'default'`. Feeds the page geometry's `colMax`; also settable from the command palette ("Document width: ..."). The rail threshold (888px) is width-setting independent since `COL_MIN` governs it.
- **Prose size**: `'small' | 'default' | 'large'` (14px/16px/18px), default `'default'`. Controls the rendered document body font size (`[data-prose-size]` attribute plus `.prose` font-size rules in `src/index.css`); the typography plugin's em-based spacing scales proportionally with it. Set from the General tab; also settable from the command palette ("Prose size: ...").

The Prose typeface, Document width, and Prose size controls are each an accessible
segmented control (`role="group"` with a label) whose segments show a crimson
focus-visible ring on keyboard focus.

Note on templates: the default template texts contain no em-dashes; `parseSettings` upgrades persisted copies of the pre-2026-07-10 default texts in place (exact-match only, customized templates untouched).

### Themes

Light: light, sepia, solarized, github. Dark: dark, nord, rose-pine, catppuccin. System follows OS.
The default light and dark themes use a red-pen palette (warm neutrals, crimson accent).
The document viewer renders on a raised sheet via the `.doc-sheet` class, with the shadow
value supplied per-theme through `--theme-sheet-shadow`. Rendered code blocks (`pre`) use
`--theme-code-text`, falling back to `--theme-text-secondary` when a theme doesn't set it;
the dark theme sets it to `#cdc6b9`, a step brighter than its secondary text color, so code
stays readable against `--theme-bg-inset`. Other themes are unaffected.

Document links in rendered prose are ink-colored with a quiet accent-colored underline
(`--theme-accent` at 45% via `color-mix`), switching to crimson only on hover; raw-view
links (`.raw-link`) match. Inline code and code blocks stay neutral in both views,
never the crimson accent.

The default dark theme's canvas is darker (`--theme-bg-secondary: #0f0e0d`), its comment
highlight fill is a richer amber (`rgba(245, 158, 11, 0.32)`, hover `0.42`, opaque
`#624514`), and its sheet shadow is stronger than the other dark palettes.

Both theme pickers, the Settings panel's Theme tab and the toolbar's `ThemeSelector`
dropdown, show a miniature live page preview per theme (`ThemePreview.tsx`: sheet
background, fake text lines, a highlighter stroke, an accent stroke) instead of a
plain color dot.

Comment cards (`CommentCard.tsx`) carry the same red-pen language into the rail, drawer, and
popover. The anchor excerpt is a serif italic pull-quote (`.comment-quote`) with a left rule
in the highlighter color, not a monospace chip; a resolved comment's quote switches to a
muted, borderless variant (`.comment-quote-resolved`). The status pill is amber (anchor tint)
for Open and neutral surface-inset for Resolved, and the Resolve action uses the green
success intent (recolored from crimson so it does not read as destructive next to Delete;
toasts and the review banner carry the crimson budget instead). Keyboard focus on a
card (`ThreadCard.tsx`) shows a `focus-visible` ring in `--theme-accent-ring` in place of the
browser's native outline.

Overlay surfaces (command palette, settings, file opener, keyboard shortcuts, confirm dialog)
share a 140ms fade/scale enter motion via the `.overlay-backdrop-enter` and
`.overlay-panel-enter` utility classes in `src/index.css`. Both respect
`prefers-reduced-motion` and exit instantly with no exit animation.

### Command palette

`Cmd+K` opens the palette. Commands include: navigation (next/prev comment, find),
tabs (prev/next), view toggles (comments rail, file explorer, outline, raw/rendered, diff,
inline edit mode),
file ops (reload, open, mark reviewed), settings, keyboard help, all themes,
comment bulk ops (resolve all, delete all, hand off to agent), active comment ops
(resolve, reopen, delete), heading jump, diagram view (open diagram in fullscreen),
agent asks (jump to next agent question, which shows the pending count and cycles
through questions on repeat invocations).

### Update notice
A quiet, persistent pill (`UpdateNotice.tsx`, `data-update-notice`) sits
bottom-right, stacked above the toast slot, when `GET /api/version` reports a
`latest` the user has not already dismissed (`useUpdateNotice.ts`). It shows
the new version, the upgrade command (`npm install -g md-redline@latest`)
with a **Copy** button, and a dismiss control; unlike a toast it does not
auto-hide. Dismissal is per version, saved as `updateDismissedVersion` via
`PUT /api/preferences`, so a later release still notifies. The CLI shows the
equivalent notice as a line printed after opening the browser: `Update
available: <current> -> <latest>. Run: npm install -g md-redline@latest`.

## Parser API

Key exports from `src/lib/comment-parser.ts`:

- `parseComments(rawMarkdown)` — parse markers, return comments + clean markdown
- `insertComment(rawMarkdown, anchor, text, author?, ...)` — add a new comment
- `removeComment(rawMarkdown, commentId)` — delete a comment marker
- `resolveComment(rawMarkdown, commentId)` / `unresolveComment(...)` — toggle resolved
- `editComment(rawMarkdown, commentId, newText)` — update comment text
- `addReply(rawMarkdown, commentId, text, author?)` — add threaded reply
- `editReply(...)` / `removeReply(...)` — modify replies
- `removeAllComments(rawMarkdown)` — strip all markers
- `resolveAllComments(rawMarkdown)` — resolve all open comments
- `removeResolvedComments(rawMarkdown)` — delete resolved markers
- `detectMissingAnchors(cleanMarkdown, comments)` — find orphaned comments (returns `Set<string>` of comment ids whose anchor text is absent from `cleanMarkdown`)
- `moveComment(rawMarkdown, id, newAnchor, hintOffset?)` — re-anchor an existing comment to `newAnchor`; preserves id, author, timestamp, replies, and status; refreshes context
- `stripInlineFormatting(md)` — plain text with offset mapping

From `src/lib/agent-prompts.ts`:

- `buildAddressCommentsPrompt(options)` — generate LLM prompt for addressing review comments

## Development

Prerequisite: Node 20 or newer.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run lint
npm test         # build + unit tests
npm run test:unit
npm run test:e2e
npm run eval:dry
```

Type checking gotcha: the root `tsconfig.json` is a solution-style file
(references only), so `npx tsc --noEmit` at the repo root checks NOTHING and
exits clean. Always verify types with `npx tsc -b` (what `npm run build`
runs); it enforces the per-project configs, including `erasableSyntaxOnly`,
which bans constructor parameter properties, enums, and namespaces even in
test files.

Key E2E specs in `e2e/`:
- `orphan-comments.spec.ts` — orphan detection surface + Re-anchor to selection recovery flow

To exercise the diff/handoff workflow without spinning up a real agent,
run the local simulator against any markdown file:

```bash
tsx scripts/simulate-agent.ts            # full sim on sample.md
tsx scripts/simulate-agent.ts --dry-run  # preview without writing
tsx scripts/simulate-agent.ts --reply-only path/to/file.md
```

It edits content near each open comment's anchor, adds a canned reply, and
optionally resolves the thread, useful for poking at the diff overlay,
the "no content changes" empty state, and the diff-reference/handoff plumbing.

## Eval notes

- `eval/fixtures/` currently contains 15 cases.
- Results are written to `eval/results/<timestamp>_<agent>_<format>/`.
- Scoring weights: parsing 25% (markers removed?), execution 50% (content changes address feedback?), integrity 25% (valid markdown, no malformed markers?).

## Release notes

When generating release notes, follow the format and rules in
`scripts/RELEASE_NOTES_TEMPLATE.md`. Gather context from `git log` between
the previous tag and HEAD, then write notes matching the established pattern.

## Documentation policy

- Update `README.md` first when product behavior changes.
- Keep this file as the single source of agent-facing docs. CLAUDE.md has only Claude-specific skill routing.
- Do not duplicate content between AGENTS.md and CLAUDE.md.

## Known issue

1. Saving `.md` files inside the project can still trigger Vite reloads even with `watch.ignored: ['**/*.md']`.
