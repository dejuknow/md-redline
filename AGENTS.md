# md-redline

Use [README.md](./README.md) as the canonical product, usage, and feature reference.

**This is the single source of truth for agent-facing docs.** CLAUDE.md contains only
Claude-specific skill routing and points here. Do not duplicate content between the two files.

## Repo snapshot

- Local web app for inline review comments in markdown files
- Frontend: React 19 + TypeScript + Tailwind CSS v4 + Vite 8
- Backend: Hono server in `server/index.ts`
- CLI entry: `bin/md-redline`, exposed as `mdr` and `md-redline`; the body is `bin/cli.js`

## Architecture overview

A Hono server serves both a Vite-built React SPA and a REST API.
An optional MCP stdio server lets AI agents request human review and wait for feedback.

### Directory layout

- `bin/md-redline` — published entry point (`mdr` command), a shim that imports `bin/cli.js`
- `bin/cli.js` — the CLI itself. Starts server, opens browser, handles `mdr mcp install`.
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
- `bin/fs-atomic.js`: `atomicWriteFile` (temp + rename, temp removed on failure) and the
  transient-error retry both the document save paths and preferences write through. Windows
  bounces filesystem calls with EPERM/EACCES/EBUSY while a scanner or indexer holds a handle;
  every write of a user-visible file should go through `atomicWriteFile` rather than a bare rename.
  It also carries the destination's mode onto the replacement, so a save never relaxes 0600 to
  0644. The retry gate is per-errno, NOT per-platform: EBUSY is contention everywhere (SMB, NFS,
  and the FUSE/FileProvider mounts behind Dropbox, Google Drive and iCloud all return it), while
  EPERM/EACCES are retried only on `win32`, because on POSIX they mean a permanent permission
  condition. It also exports `errorCode`, the one place the unchecked cast from a caught
  `unknown` to an errno-bearing error is written down, which is what every `catch` in `bin/`
  reads a `.code` through. `server/fs-retry.ts` re-exports it for server-side importers
- `bin/file-lock.js`: `acquireFileLock`, the O_EXCL cross-process lock every writer of
  `.md-redline.json` takes around a read-modify-write. Shared so `mdr --restrict` and the server
  cannot interleave; its attempt budget derives from `FS_RETRY_BUDGET_MS`. Exhausting that budget
  throws `LockContentionError`; any other throw is a filesystem error with its errno intact, and
  callers word their advice from that difference. A lock older than `LOCK_STALE_MS` is stolen as
  abandoned, so holding one is not the same as still holding it: each acquisition writes a
  `pid uuid` token and release unlinks only a lock still carrying it. The module installs its own
  SIGINT/SIGTERM/SIGHUP and `exit` handlers while any lock is held, removes them once the last one
  is released, and re-raises the signal so the process still dies with the status it would have
- `bin/home-dir.js`: `resolveHomeDir` (`MD_REDLINE_HOME` or the OS home), which decides where
  `.md-redline.json` lives. Shared because a CLI resolving it differently from the server locks
  and writes a file the server never reads
- `bin/version-compare.js`: strict x.y.z version compare shared by the server's update checker and the CLI
- `src/lib/comment-parser.ts`: parse, insert, edit, delete, reply, resolve, anchor updates
- `src/markdown/pipeline.ts`: markdown -> sanitized HTML pipeline
- `src/components/MarkdownViewer.tsx`: rendered markdown, selection handling, highlight painting
- `src/components/RawView.tsx`: raw markdown view with syntax highlighting and diff overlay
- `src/components/RenderedDiffView.tsx`: rendered prose view of the diff overlay
- `src/components/ReviewBanner.tsx`: review session banner (send batch, finish, cancel)
- `src/components/PanelToolbar.tsx`: shared per-panel toolbar (search, view-mode, copy, handoff, diff controls)
- `src/components/AccessRequest.tsx`: the folder-permission ask shown when a path is outside the allowed roots
- `src/components/Tooltip.tsx`: portal-based tooltip with snappy delay + scrubbing grace period
- `src/hooks/useComments.ts`: comment actions, handoff prompt generation, workflow logic
- `src/hooks/useReviewSession.ts`: polling and heartbeat for active review sessions
- `src/hooks/useDiffLines.ts`: single source of diff state shared by raw view, rendered view, and the toolbar badge
- `bin/cli.js`: auto-start CLI and browser opener
- `eval/runner.ts`: eval harness; default adapter is currently `claude-cli`

## Comment format

Markers sit immediately **before** the anchor text they refer to:

```
Some text <!-- @comment{"id":"uuid","anchor":"highlighted text","text":"comment body","author":"User","timestamp":"ISO-8601","status":"open","replies":[{"id":"uuid","text":"reply","author":"User","timestamp":"ISO-8601"}]} -->highlighted text continues here.
```

- `anchor` — the originally selected text (what the comment refers to). It is a lookup key, not a label: an edit that rewrites the anchored text without updating this field detaches the comment. The hand-off prompt tells agents to keep it in sync, and `parseComments` recovers from the marker's position when they don't (see "Anchor recovery after a rewrite")
- `text` — the reviewer's feedback
- `replies` — threaded discussion array
- `status` — `open` or `resolved` (only present when resolve workflow is enabled); a comment is an **orphan** when its `anchor` can no longer be located in the current document *and* position recovery found nothing to attach it to
- `contextBefore` / `contextAfter` — surrounding text for fuzzy re-matching when anchor is edited
- `agentInitiated` — `true` when the marker was created by an agent (via `mdr_ask` or `mdr_review`).
- `expectsReply` — `true` while an `mdr_ask` question is awaiting the user's answer. Cleared when the user replies (addReply/appendReply), when the session ends (End review / Finish review), or by the stranded-marker sweep after a server restart. A marker with `agentInitiated: true` but no `expectsReply` is "asked, closed": a record, not a pending question.
- `sessionId` — links an agent-initiated marker to a review session for reply routing.
- Strip all `<!-- @comment{...} -->` markers to get clean content
- Marker position disambiguates when the same text appears multiple times

### Protected containers

Some containers can't hold an inline marker, so `insertComment` relocates one that
resolves inside them. The `anchor` is never rewritten: it stays the real text, so
highlighting, orphan detection, and agent handoff are unaffected.

| Container | Where the marker goes | Why |
|---|---|---|
| Fenced code block | Before the opening fence, own line | A marker inside is literal text |
| YAML/TOML frontmatter (offset 0 only) | After the closing fence, own line | It can't go before, and a comment body containing `: ` breaks the YAML parse |
| HTML comment | Before the block; own line only when the comment owns its line | Nested comments don't exist: the first `-->` closes the outer one and the rest becomes visible text |

The ranges are computed with regexes, and each container's scan excludes the
others (a fence line inside frontmatter is YAML, a `<!--` inside a fence is
sample text). Do not add a fifth exclusion: four rounds of that have already
happened and the fourth cost a silently lost comment. #30 tracks replacing the
computation with ranges derived from the parse.

**Placement alone treats an unclosed fence as running to end of document**
(`getCodeBlockRanges`'s `unclosedRunsToEof`), because that is how every renderer
reads one, and without it a marker went into the user's code. Detection is
deliberately NOT told: teaching it would make every marker below such a fence
vanish from documents that already contain them. The asymmetry only runs one
way on purpose. Insertion protecting more than detection sees can only push a
marker further out, into text detection does read; the reverse, a container
insertion knows about and detection does not, is what silently loses comments.

## API endpoints

**Files**
- `GET /api/file?path=` — read markdown file
- `PUT /api/file` — write markdown file (supports optimistic concurrency via `expectedMtime`)
- `GET /api/files?dir=` — list markdown files in a directory
- `GET /api/browse?dir=` — browse directory structure (files + folders)
- `GET /api/asset?path=` — serve image assets (PNG, JPG, SVG, etc.)
- `GET /api/watch?path=` — SSE stream of external file changes
- `POST /api/pick-file` — native file picker (macOS/Linux/Windows)
- `POST /api/pick-folder` — native folder picker

These two are POST despite reading like reads. They spawn a native OS dialog and
persist a new trusted root once the user picks, so they must sit behind the
`application/json` Content-Type guard, which a cross-site page cannot satisfy
without a CORS preflight. As GETs they were reachable from any markup that can
emit a URL, including an `<img>` in a reviewed markdown document, which the
renderer passes through verbatim when the URL carries a scheme.

Any new route that lets a caller direct a change must use POST or PUT, because
those are exactly the two verbs the Content-Type guard checks (`server/index.ts`,
the middleware after the Fetch Metadata one). `PUT /api/file` and
`PUT /api/preferences` are the existing PUTs and are covered. A route added on
DELETE or PATCH would NOT be covered, so extend the guard's method list before
reaching for one. Do not rely on the `Sec-Fetch-Site` check instead: it fails
open for clients that send no Fetch Metadata.

One existing GET does write: `GET /api/file` calls `sweepStrandedAskMarkers`,
which can rewrite the file to clear an `expectsReply` flag whose review session
has already closed. That stays a GET deliberately. It is idempotent self-healing
triggered by server-side session state, the caller cannot direct what it writes,
and it only ever removes a stale flag. The rule above is about writes a caller
chooses, not about every byte that can reach disk during a request.

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

**Host allowlist and reverse-proxy fronting** — a Host-header check closes DNS
rebinding by rejecting any hostname that is not loopback. `CreateAppOptions.allowedHosts`,
defaulting from the comma-separated `MD_REDLINE_ALLOWED_HOSTS`, adds extra names
so the loopback-bound server can sit behind a trusted proxy (`tailscale serve`,
nginx, Caddy). Both the header and the allowlist entries are normalized through
the exported `normalizeHostname`, so the two sides cannot drift apart. It strips
a scheme, a protocol-relative `//`, any path, query or fragment, userinfo, a
port, IPv6 brackets and trailing dots, then lowercases. That list is deliberately
generous: an operator pastes whatever `tailscale serve status` or the address bar
gave them, and every form that silently fails to match is a support ticket whose
symptom (all proxied requests 400) points nowhere near the typo. Entries that
normalize to nothing are dropped with a warning. Non-ASCII hostnames must be
written in punycode, since that is what a browser puts in the Host header. A Host
header that is present but empty is checked and fails closed. The bind address is
never affected.

There is no authentication anywhere in the server, so setting `allowedHosts`
moves the trust boundary from this machine to whatever can reach the proxy.
Two consequences worth keeping in mind when adding routes: `trustedRoots` is
stripped from `PUT /api/preferences` because persisted roots hydrate into
`allowedRoots` on the next launch (accepting it let a client grant itself a
directory and read it back after a restart), and every route that lets a caller
direct a change must use POST or PUT, the two verbs the `application/json` guard
checks. See the README section "Reaching md-redline from another device" for the
operator-facing version.

**Environment variables** that a user sets use the `MD_REDLINE_` prefix. New
user-facing variables take the prefix.

Two aliases predate the convention and still work, because both shipped and are
documented in the README's config table: `MDR_BROWSER` for `MD_REDLINE_BROWSER`,
and a bare `PORT` for `MD_REDLINE_PORT`. Do not remove either without a major. In
both pairs the prefixed name wins, but only if it is non-EMPTY. Blank counts as
unset everywhere, because a plain `??` keeps an empty string and an empty string
is rarely harmless: `MD_REDLINE_PORT=""` used to beat a working `PORT` and reach
`Number.parseInt('')`, and the resulting NaN aborted startup with "No available
port found (tried NaN-NaN)"; an empty `MD_REDLINE_HOME` resolved
`.md-redline.json` against the current working directory, so trusted roots were
written wherever the user launched from and never persisted.

One resolver per variable, imported by every reader: **more than one place reads
the same variable, and the readers have to agree.** `vite.config.ts` resolves the
API port to aim its dev proxy, `server/index.ts` resolves it to decide what to
bind, `bin/cli.js` resolves it to seed the fallback scan that finds a running
server, and `server/update-check.ts` resolves the home directory independently of
`server/index.ts` (the update checker is constructed with no `homeDir` option, so
that read is live in production).

Three inline copies is what that replaced, and they did disagree. `PORT=7100`, the
alias the README documents, bound the server and aimed the proxy at 7100 while the
CLI scanned from 6373, because the CLI's copy read only the prefixed name; the CLI
could then find the server through the port file or not at all. A blank
`MD_REDLINE_PORT` aborted the server with "No available port found (tried
NaN-NaN)" and killed `npm run dev` with `ERR_SOCKET_BAD_PORT`, while the CLI
quietly fell back to 6373. Only a malformed value like `7100nonsense` was
consistent, and only because all three truncated it the same way; all three now
reject it. Add a resolver and import it; never inline a second copy.

The port resolvers live in `bin/ports.js`, not in `server/env.ts`, and that
location is deliberate. `bin/cli.js` reads the API port too, to seed the
fallback scan that locates a running server when the port file is missing or
stale, and it is a dependency-free CLI with no build step, so it can only import
plain JavaScript. `bin/` is also what package.json ships next to `dist/`, so the
module is present in an npm install. `server/env.ts` re-exports it, esbuild inlines
it into `dist/server.js`, and `vite.config.ts` reaches it through `server/env.ts`.
Three readers, one function. Types come from the JSDoc in the module itself.
They used to come from a hand-written `bin/ports.d.ts`, because at the time
`allowJs` really would have typed every `bin/` import as good as `any`: the
sources carried no annotations to infer from. Once `tsconfig.bin.json` went
strict they do, so the declarations were deleted and `server/` reads the
implementations. A wrong argument to any of them is a build error again, which
is what the declarations were for, except that nothing had ever checked THEM
against the code they described.

**Which running server a command acts on is `serverProbeOrder`** (in
`bin/server-control.js`, with the rest of finding and acting on a running
server, rather than in `ports.js`, which resolves what port to bind)**, and the
order is a correctness property.** A port the user NAMED (`MD_REDLINE_PORT`, or the
`PORT` alias) is probed before the one in the port file, then the scan ranges,
deduped. The port file records whichever server started last, so consulting it
first meant a command aimed at one instance acted on another and said it
succeeded: `--stop` killed the wrong server, and a plain `mdr` attached to it.
Deciding this needs `resolveNamedApiPort`, not `resolveApiPort`, because that
one answers 6373 both to an explicit `MD_REDLINE_PORT=6373` and to nothing set
at all. With nothing named the port file still comes first, and has to: it is
how a server that scanned upward past a busy default is found.

`bin/fs-atomic.js`, `bin/file-lock.js` and `bin/home-dir.js` live there for the
same reason, and it matters more for them: the CLI writes `.md-redline.json`
(`mdr --restrict`, and the trust disclosure reads it) while the server rewrites
it on every boot. A second copy of the retry would drift, and a second copy of
the lock would not be a lock at all, since two writers taking different locks
are not serialized against each other. `resolveHomeDir` is in the same set for a
sharper reason: a lock is only shared if both sides compute the same PATH, and
under `MD_REDLINE_HOME` a CLI using bare `homedir()` locked and wrote a file the
server never read, then reported success. `server/fs-retry.ts` re-exports the
first, `server/env.ts` the third; `server/preferences.ts` imports the second
directly.

The lock covers `.md-redline.json` only. Claude Desktop's MCP config gets the
atomic write, which is what keeps a bounced or interrupted write from
truncating every other MCP server out of it, but NOT the lock: Claude Desktop
does not take ours, so a read-modify-write there still races that app. Nothing
in this repo can fix that; `mdr mcp install` is a one-shot the user runs
deliberately, which is what keeps the window small.

**`bin/` is checked by `tsconfig.bin.json` (`checkJs`) and its own eslint block.**
It has no build step, so before those existed eslint matched none of it and
exited 0 having checked nothing, which reads exactly like passing, and `tsc`
never saw it at all. A call to an undefined function survived both gates. The
config now runs the same `strict` as `tsconfig.node.json`, so a JS file here is
held to what a TS file is held to in `server/`; types are carried in JSDoc,
since there is no build step to strip anything. The CLI body is checked too,
which is why it is `bin/cli.js` and not `bin/md-redline`: an extensionless file
matches no glob `tsc` accepts, and that name is the published command and cannot
change. What is left unchecked is the shim itself, which is why it does nothing
but import.

The `include` list names `bin/**/*.js`, `bin/**/*.test.ts` and the browser stub
one at a time, and must stay that way. A `.d.ts` caught by a wider glob SHADOWS
its `.js`: TypeScript drops the implementation from the program and checks the
declaration instead, which silently stops checking the file. Nothing here is a
`.d.ts` today, and that list is what keeps a new one from quietly turning a
checked module back into an unchecked one. After editing it, confirm what is
actually in the program with `tsc -p tsconfig.bin.json --listFiles`.

**`server/` imports these JS modules directly, under `allowJs`.** There are no
hand-written declarations any more. They existed because untyped JS would
otherwise have come across as `any`, which stopped being the case when this
directory went strict: the JSDoc is now complete enough to type every importer,
and a wrong argument in `server/` is a build error. The rule that replaces them:
a JS module in `bin/` is only as good as the annotations on it, so anything
`server/` imports has to stay inside `tsconfig.bin.json`'s include, which is
what actually checks those annotations. `allowJs` alone would infer, not check.

`MD_REDLINE_REGISTRY_URL` and `MD_REDLINE_BASE_URL` keep a plain `??` by choice:
both are development or background-only, and a blank value fails visibly at the
first fetch rather than quietly doing the wrong thing. `NO_UPDATE_NOTIFIER` and
`CI` are presence-checked on purpose, per ecosystem convention, where an empty
value counts as set.

Two further sets are deliberately outside the rule. `MD_REDLINE_INTERNAL_BROWSER_*` are
set by `bin/cli.js` and expanded by the Windows `cmd` it spawns, never read
through `process.env`, so a `process.env` grep will not find them: they are an
argument-passing mechanism rather than configuration. `RELEASE_SKIP_CI_CHECK` and
`RELEASE_SKIP_CLAUDE` are local to `scripts/release.mjs`.

**Ports and loopback discipline** — the API server binds IPv4 loopback only
(`127.0.0.1`), default port 6373 ("MDR" on a phone keypad; overridable via
`MD_REDLINE_PORT`), scanning up to 10 ports from there if taken. The Vite dev
client uses 5188 (`MD_REDLINE_VITE_PORT`), same scan. The CLI (`bin/cli.js`)
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
`MD_REDLINE_BROWSER` to override with an explicit command that is spawned with the URL
as its argument. Every launch goes through `spawnDetached`, which on Windows
must pass `detached: true` (opt-in per call) so the child outlives the CLI's
near-immediate exit; without it the launcher is torn down before it runs. The
long-lived server deliberately stays non-detached, since a detached child gets
its own console window on Windows that `windowsHide` cannot suppress under
`shell: true`. The undocumented `mdr __open <url>` subcommand runs only the
launcher and exits; the browser-open regression test
(`bin/open-launch-cli.test.ts`) drives it with `MD_REDLINE_BROWSER` pointed at a stub.
The undocumented `mdr __port` prints the API port the CLI resolved and exits, which
is the only way to observe it: that value only seeds the fallback scan inside
`findServerPort`, and `--stop` would kill whatever it found. The same test file uses
it to prove the CLI agrees with the server and `vite.config.ts`.

The undocumented `mdr __find-server` prints which running server this invocation
would act on (or `none`) and touches nothing, which is the only way to observe
that choice: every other command that makes it then either kills the server or
opens a browser at it, and neither is something a test can do to a developer's
machine. `bin/find-server-cli.test.ts` drives it against fake servers with the
port file redirected via `TMPDIR`.

The undocumented `mdr __first-launch` prints which trust disclosure this
invocation would print (`seeded`, `unreadable` or `configured`) and exits, for
the same reason: the answer is otherwise a line or two of text in the middle of
a real startup. `bin/prefs-cli.test.ts` pins all three.

The three-way split exists because the two obvious answers are both wrong. A
returning user should not be greeted as a newcomer, but staying silent when the
prefs file is UNREADABLE hides something they need: `createApp`'s first-launch
branch fires on `trustedRoots === undefined`, an unreadable file is
indistinguishable from that, and the branch applies the home-directory seed in
memory even though it refuses to persist it. So a user who ran `mdr --restrict`
gets home trust back for that session, silently, which is exactly what they opted
out of. `unreadable` says so in its own words rather than welcoming them.

**CLI stale-server upgrade**: on every plain `mdr` invocation,
`ensureServerRunning()` in `bin/cli.js` asks the running server for
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
  // Exactly one of these two names the target session:
  filePaths?: string[]           // absolute paths, length >= 1; opens a new session
  sessionId?: string             // post into a session that already exists

  comments?: Array<{             // new top-level comments
    filePath: string             // must appear in filePaths[] (filePaths form)
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

At least one of `comments[]` or `replies[]` must be non-empty. Passing both
`filePaths` and `sessionId` is rejected, as is passing neither.

In the `filePaths` form the tool opens the browser at the session URL
(`origin: 'agent'`), writes the markers, and returns IMMEDIATELY
(fire-and-forget). The result instructs the agent to call `mdr_wait` with the
returned sessionId. Partial-anchor failures are surfaced as `failedComments[]` /
`failedReplies[]`, and a failed multi-file batch rolls back the markers it
already wrote.

In the `sessionId` form the batch is posted into the named session and that
sessionId is returned unchanged — no `grantAccess`, no `createSession`, no
browser tab. This is the only way to reach the user-origin session an
`mdr_request_review` handoff opened: `findOpenSession` filters dedupe on origin
(agent- and user-origin sessions have incompatible terminal-state semantics), so
the `filePaths` form always mints a second session for a file the user is already
reading, costing a duplicate tab and a second banner row. Use `sessionId` for
replying in-thread as work lands. Path validation is the server's: `/agent-comments`
resolves every path and rejects any outside the named session's `filePaths`, which
is stricter than the client-side `filePaths[]` membership check.

Do NOT follow a `sessionId`-form post with `mdr_wait` unless you opened that
session with `mdr_review` yourself. `mdr_wait` long-polls `/agent-wait`, which
409s on user-origin sessions, so calling it on an `mdr_request_review` handoff
errors. The result text says which continuation applies; for a handoff it is
`mdr_request_review` with the same sessionId.

**Picking between `mdr_review` and `mdr_request_review`.** The two are named
from opposite points of view: `mdr_review` is the agent reviewing,
`mdr_request_review` is the human reviewing. "I want to review spec.md in mdr"
therefore names the wrong one lexically, and the failure is not quiet, since
`mdr_review` writes markers into a file the user only meant to read. Both
descriptions carry the disambiguation, and `mdr_request_review` claims those
phrasings in its first sentence. Keep that split intact when editing either.

**`mdr_wait`** — `{ sessionId }`. Blocks (90s re-poll cycle via `/agent-wait`)
until the user clicks End review. Returns "done, re-read the file(s)" on End
review, a reason-specific message on other terminal paths (cancelled, tab closed,
agent_silent GC, finished), `pending` when the agent should re-poll, and a
graceful "session unknown, server may have restarted" result on 404. The two-tool
flow `mdr_review` (post) → `mdr_wait` (block) applies to the `filePaths` form only.
A `sessionId`-form post into a session you did not open does not get a `mdr_wait`;
see the caveat under `mdr_review` above.

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

The open-file button is sticky at the right edge of the tab strip, so it overlays
whichever tab ends there. The strip carries a `scroll-pr-10` that must stay at or
above that button's `w-9`, otherwise the browser parks the active tab underneath
it when scrolling the tab into view.

### Folder permission requests
Opening a file outside the allowed roots is a consent moment, not a failure, and
`AccessRequest.tsx` is the only place that says so. The document area renders it
over the sheet (`variant="page"`), the explorer renders the quieter
`variant="panel"` when a browse is refused, and the toolbar stays out of it
whenever the card is up. Three surfaces shouting the same absolute path in
`text-danger` was the state this replaced; if a fourth surface ever needs to
report a refused folder, give it a variant here rather than its own copy.

**The card covers the document, it does not replace it.** It is an
`absolute inset-0` overlay inside the viewer's relative wrapper, and the viewer
tree stays mounted behind it. Swapping it in as a sibling branch looks tidier
and breaks two things: `usePageGeometry` observes `containerRef.current` in an
effect keyed `[containerRef, enabled]`, neither of which changes when the card
clears, so unmounting the scroll container leaves its ResizeObserver attached to
a detached node and the sheet stops tracking the window for the rest of the
session; and the viewers are what report the search match count, so a denied tab
kept the previous document's count over a card with no text. Both are pinned by
the resize assertion in `e2e/error-states.spec.ts`.

Two conditions gate it, and they are not the same one:
- `showAccessRequest` (App) is `errorKind === 'access-denied' && !rawMarkdown`.
  The `!rawMarkdown` term is load-bearing: `reloadFile` keeps the loaded content
  on failure, so a directory that rotates out from under an open file 403s a tab
  the user is still reading. The card must not cover a document it cannot give
  back. Those tabs keep their content and the toolbar reports the refusal with
  its own compact Allow button, so exactly one surface ever owns the ask.
- `accessDeniedDir` may be null (`?file=~`, a Windows drive-relative path, both
  of which `getParentDir` answers with `''`). Null names no folder but still
  renders the card: the picker works from the active file either way, and a
  refusal nobody reports is a blank sheet with no way out.

The card leads with the folder's basename and puts the path under it through
`middleTruncatePath`, which elides whole segments rather than cutting names in
half, with the untruncated path in the `title`. The CSS `truncate` on that line
is an overflow guard for a panel dragged to its 160px minimum, not the
shortener. Agent scratchpad directories are the common case and their paths are
both long and generated, so a raw path wraps to four lines and still says
nothing.

The button opens the native picker (`POST /api/pick-folder`). Keep the native
dialog: it is the local consent flow that `trustedRoots` depends on (see the
security notes above), so an in-app one-click grant would move the filesystem
boundary from "the user answered an OS dialog" to "something reached the
server". The picker opens pointed at the refused folder, which is what keeps
the extra step cheap, and the card's hint tells the user they can pick a parent
to allow more at once.

`handleTrustFolder` owns that call for every surface, and three things follow
from the fact that two cards can be on screen at once:
- It resolves `true` only on an actual grant. Callers refetch on `true` alone,
  so a cancelled dialog does not spend a retry on a folder that is still
  refused, and the re-entrancy guard reports `false` rather than a phantom
  success to whichever surface did not get the dialog.
- `trustFolderPending` is shared, not per-surface. A second button that stays
  enabled while another owns the dialog invites a click the guard then swallows.
- `grantNonce` bumps on every completed grant so the explorer re-browses after a
  grant made from the document card. Without it the panel sits on a refusal that
  no longer applies, offering to re-pick a folder that is already trusted.

If the card is still up after a completed grant, the picked folder did not
contain the file; `grantMissed` swaps the hint for a line that says so, because
repeating the ask word for word reads as a dead button.

An access-denied tab's dot in `TabBar` is neutral rather than red for the same
reason the copy changed: the user can resolve it by answering a prompt. It is
`content-muted`, not `content-faint`, which falls under the 3:1 non-text
contrast minimum, and the tab's `title` carries the reason in words since a 6px
dot cannot. Background tabs opened by session restore never render the card at
all, so that dot is their only signal.

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

### Copying a document selection
The rendered view paints the pending selection as `mark.selection-highlight`
(`MarkdownViewer.tsx`), which replaces the selected text nodes and collapses the
browser's own range, so a plain Cmd/Ctrl+C would copy nothing. The document-level
`copy` handler in `App.tsx` restores it:

- `getCopySelectionFallbackText` (`src/lib/copy-selection.ts`) decides whether to
  override. It stands down outside the rendered view, when a real native selection
  still exists, and inside editable elements. The one exception is the comment
  composer: with quick comment on, the textarea takes focus the instant a selection
  is made, so a collapsed caret there still copies the document selection. Text
  selected inside the composer keeps the native copy.
- `buildRangeHtml` (`src/lib/copy-selection-html.ts`) supplies the `text/html`
  flavor. `resolveSelection` calls it at selection time and stores the result on
  `SelectionInfo.html`, before the repaint destroys the range, so the rich flavor
  does not depend on the highlight painting (or painting correctly). It clones the
  range after widening each boundary through ancestors the selection sits flush
  against, so a tight `<a>` or heading wrapper is not flattened; the walk only
  climbs content elements (`CONTENT_WRAPPERS`), never layout wrappers like the doc
  sheet, whose classes have no business on the clipboard. It then unwraps the app's
  own highlight marks, strips viewer chrome, and re-wraps the leading run of loose
  `<li>`s in their list (only the leading run, so a selection that runs out of a
  list keeps the blocks after it).

  Numbering is per level, not per list-pair. `collectListLevels` walks every
  list the range's start sits inside, outermost first, pairing each with the
  item at that list's own level, and each level gets its own `start` via
  `restoreOrderedStart` (whose offset comes structurally from that item, not
  from matching item text). Modelling this as a fixed outer/inner pair looks
  sufficient and is not: nesting is arbitrarily deep, and any list between the
  two ends up silently renumbered from 1. Separately, `owningList` picks the
  list whose items are the fragment's *top-level* nodes, which is the one
  `wrapLooseListItems` may have to rebuild because the list element itself was
  never inside the range.

  Tables get the mirror-image treatment: `rebuildTableWrapper` restores the
  `<table>` around rows or cells left at the fragment's top level by a partial
  selection, since the HTML fragment parser drops stray `<tr>`/`<td>` and
  foster-parents their text. `unwrapSingleCell` then undoes it for a selection
  that lives inside one cell, which is a text selection rather than a table
  one: copying a value out of a config table should paste the value, not a 1x1
  table.

  Locating a source list's counterpart inside the clone is not derivable by
  search (nesting, partial ancestors and dropped leading siblings all move it),
  so `buildRangeHtml` tags the source elements with `CLONE_MARK` for the
  duration of `cloneContents` and strips the attribute from both the live
  document (in a `finally`) and the clone before serializing. This is the one
  place the helper touches the live DOM; it is synchronous, and a test asserts
  the source document is byte-identical afterwards.

Both flavors go on the clipboard, so pasting into a rich-text editor keeps
headings, bold, links, tables, and list structure.
#### Touch and pen selections
Selections made by touch or pen route through a pending flow instead of the
mouseup path (`useSelection.ts`): touch selection never fires `mouseup`, and
native selection-handle drags emit no pointer events the page can see, so
nothing auto-opens; a timer cannot distinguish "paused to think" from "done
adjusting". The modality is decided per gesture via the last `pointerdown`'s
`pointerType` (not per device), so hybrid devices get mouse-immediate and
touch-deferred behavior side by side.

There is one comment surface for both modalities. `App.tsx` renders a single
`CommentForm` for `selection ?? pendingSelection`, so a touch selection shows
the same collapsed pill (Comment plus the quick templates) that a mouse
selection does. `CommentForm`'s `handleExpand` and `handlePillTemplate` both
call `onLock` first, and `onLock` commits the pending selection, so engaging
with the pill by any route promotes it. That is what keeps the two modalities
identical by construction rather than by two components kept in sync: an
earlier revision had a separate touch-only button, which drifted into a
different affordance (no templates) and cost touch users an extra tap.

The commit reads the stored `SelectionInfo` snapshot, so it survives the tap
collapsing the native selection. `selectionchange` is debounced 150ms purely to
coalesce handle-drag event streams; it gates nothing user-visible. The pill's
scroll-follow coalesces into one measurement per animation frame, because touch
scrolling outpaces the compositor and measuring per event reads as jitter.

The anchor drag handles (`DragHandles.tsx`, `useDragHandles.ts`) run on pointer
events for the same reason. Their `pointerdown` stops propagating, and that is a
reasoned choice rather than a measured one: `useSelection`'s document listener
bumps a gesture epoch that invalidates any in-flight selection timer, and a
press on a handle is not a new selection gesture. A review argued for letting it
through, because the same listener names `[data-drag-handle]` in its
preserved-selection selector; that concern is filed and unresolved. Both
arrangements pass 20 consecutive runs of the heaviest insertion spec. They were mouse-only, and reacted to a tap because
iOS synthesises a `mousedown`, so the handle highlighted and the drag appeared
to start and then received no `mousemove` for the rest of the gesture: dead on a
tablet, with nothing on screen to say so. Three things make the conversion work
and each is easy to leave out. `setPointerCapture` on the handle keeps the drag
alive once the pointer leaves it; `touch-action: none` in `.drag-handle` stops
the browser claiming the gesture for scrolling before the page sees a move; and
`pointercancel` ends a drag the system took away, which touch fires and a mouse
effectively never does. Every ending runs one `detach`, because four
copies of the teardown is how the fifth one gets forgotten, and there are five:
released, cancelled, Escape, unmounted, and capture lost. That last one is not
`pointercancel`. Removing the captured element fires `lostpointercapture`
instead and pointer events keep arriving at the document, so deleting or
resolving the comment mid-drag, or switching to the raw or diff view, left the
drag live and committed an anchor edit for something that was gone.

A second finger cannot start a competing drag: the handle refuses a
non-`isPrimary` pointer and the hook refuses to begin while one is in flight.
Either alone is enough today, which is why `e2e/touch-drag-handles.spec.ts`
asserts the behaviour rather than either mechanism. The `pointerId` recorded at
the start filters moves for a drag already running; on its own it never stopped
a second one beginning. Moves are NOT coalesced onto an animation frame, though each
runs two text walks, an `innerHTML` serialize, an unwrap-and-rewrap of the whole
prose subtree and a forced layout, and touch delivers them faster than the
display. The pipeline moves an anchor only when it walks: a 300px drag in five
steps extends it and the same drag in one step leaves it untouched, so applying
only the last position of a frame moves it nowhere. Batching briefly shipped and
turned an existing spec red on CI, where a loaded runner starved the frame and
collapsed the steps into one jump. `e2e/touch-drag-handles.spec.ts` starves
frames deliberately to keep that from coming back; anything that batches these
has to preserve the intermediate positions.

`e2e/touch-drag-handles.spec.ts` drives this through CDP
`Input.dispatchTouchEvent`, not dispatched DOM events: #33 established that
synthetic-pointer tests here pass even with the touch handlers deleted.

### Comments rail
The single comment surface for the rendered view: a fixed-width column at the
right edge of the document page, inside the same width-managed page unit as
the prose column (`src/lib/page-geometry.ts`, `CommentsRail.tsx`). Two
densities, switched via the segmented control (`RailDensityControl`,
`[data-rail-header]`) that renders in the panel toolbar's right group while
the rail is shown (a header inside the rail occluded the anchored cards), and
persisted per-user (see below). Each density segment shows a crimson
focus-visible ring on keyboard focus.

`RailDensityControl` is the whole comment cluster, not just the toggle. Left to
right: prev/next comment buttons (`[data-rail-prev]`, `[data-rail-next]`, wired
to the same `handleJumpToPrev` / `handleJumpToNext` as the `P`/`N` shortcuts,
which their tooltips name; disabled when the file has no comments), the density
segmented control, the open count, and an overflow kebab
(`[data-rail-actions]`). The kebab opens a `ContextMenu` with the bulk actions:
**Resolve all open** (resolve workflow on, open comments exist), **Clear
resolved** (resolve workflow on, resolved comments exist), and **Delete all
comments...** (always, behind the same `ConfirmDialog` the list footer uses).
The kebab is hidden entirely when the file has no comments. These duplicate
`CommentListSurface`'s footer buttons on purpose: the footer only exists in List
density and the drawer, so the kebab is the one route that works in Anchored
density too.

Tab badges count ALL open comments including
agent-initiated ones (`tabCommentCounts` in App); the handoff button keeps
the sendable-only map. Inline code in prose renders neutral (`--theme-text`
on `--theme-bg-inset`), never the crimson accent:

- **Anchored** (default): cards align to their document anchors. Cards are
  compact by default (anchor text, comment preview, reply summary); the active
  card (selected by clicking its highlight or the card itself) expands to the
  full thread view with all actions, including Reply. A compact card's replies
  collapse to a clickable disclosure line naming who replied ("2 replies from
  Claude and Dennis", `data-testid="reply-summary"`); clicking it activates the
  card, which is what expands the thread. Replies that arrived from outside the
  app since the reader last opened that card are tracked per file path by
  `useUnreadReplies` (session-only, never persisted) and fed in as
  `unreadReplyIds`; when a card has any, the line counts and attributes only
  those, reading "1 new reply from Claude" in the accent color with
  `data-unread="true"`. The line names at most two authors and counts the rest
  ("3 replies from Claude, Dennis +1"); the author dots come from the same cap,
  so every dot belongs to a name on the line. All three paths that take content
  from disk mark arriving replies, through `applyExternalContent` in App: the
  active tab's `onExternalChange`, the multiplexed background-tab SSE handler
  (the case that matters most, since no toast fires there), and an explicit
  reload. None of them mark anything while a tab's first fetch is still in
  flight, since with no prior content to diff against the file's whole reply
  history would look new. Stamping a reply changes the content, so both SSE
  paths write it back through `scheduleBackfillWrite`, one debounce timer per
  path. That write is not a save and must not behave like one: it waits 2s so an
  agent can finish a batch, and it goes out as a direct fetch rather than
  through the save queue, which reports a 409 as a failed save. Here a 409 is
  the ordinary outcome, because the agent writes again in the meantime and the
  next event re-triggers the backfill. Activating a comment marks its replies read, in
  either density. Only anchored density surfaces the unread state, because
  it is the only one that hides reply text; List density renders every reply
  in full but does not clear the marks by itself, so a reply read there stays
  marked until the reader opens that comment. A connector line runs
  from the anchor to the active (or hovered) card along the rail's left edge.
  Cards never overlap: they resolve top-down by anchor position, and the
  active card gets priority to sit at its anchor, compressing cards above it
  upward when needed, capped at `MAX_LIFT` (96px) above each card's own
  anchor (`src/lib/margin-layout.ts`); past the cap the active card shifts
  down by the residual instead of lifting other cards further. Comments
  whose anchor text can't be found in the document (orphans) stack in a
  block at the top of the rail, above the
  anchored cards. Resolved comments get no card in this density (App's
  `marginComments` filters them out); their thread lives in List density's /
  the drawer's Resolved filter. Their anchor still paints a faint dotted
  underline in the prose (`mark.comment-highlight-resolved`) so a passage that
  was discussed keeps a trace, and clicking that trace opens the single-thread
  `CommentPopover` — the same surface used when the rail is hidden — because
  `railCanShowThread` reports that Anchored density has nowhere to put it. A
  highlight group paints the resolved treatment only when every comment in it
  is resolved; one open comment on the same anchor keeps the full highlight,
  and the settled ids stay out of that mark's `data-comment-ids` entirely. The
  consequence is worth knowing: a resolved comment sharing an anchor with an
  open one gets no trace, no density tick, and no scroll target, and is
  reachable only from List density / the drawer.
  The trace is suppressed inside Mermaid blocks, where a CSS `text-decoration`
  on a `<mark>` stops foreignObject labels from wrapping; the post-render pass
  in `MarkdownViewer` strips the resolved classes and the `data-comment-ids`
  from those marks, so a diagram label is not left invisibly clickable. (The
  fullscreen diagram modal does not share that strip and still paints resolved
  labels as live.) Because the marks now exist, resolved comments also reach
  the density strip as green `resolved` ticks (`useCommentTicks`), which they
  never could before. A tick click routes through the same surface decision as
  a highlight click (`revealCommentThread`), so it opens the popover rather
  than activating a comment the rail will not draw. Right-clicking a trace
  omits Edit and Reply, matching the card surfaces, which hide both while a
  thread is settled; Jump to Sidebar calls `ensureCommentSurface(commentId)`,
  which falls back to the drawer when the rail would draw no card for that
  comment (and closes the popover on the way, so the two never stack).
  Anchors that OVERLAP without matching land in separate highlight groups, so
  the same-anchor rule above does not cover them: `wrapText` walks into marks
  that are already painted, which nests the shorter anchor inside the longer
  one. `markToAct` in `MarkdownViewer` resolves clicks and right-clicks to the
  nearest OPEN ancestor mark rather than to the innermost one, so a live
  highlight keeps its own clicks; a trace entirely enclosed by one is visible
  but not clickable, and is reachable from List density / the drawer. Drag
  handles can be dragged straight across a trace: `useDragHandles` excludes
  `.comment-highlight-resolved` from the "don't drag into another comment's
  mark" guard, since overlapping a settled anchor is what resizing did for as
  long as resolved comments painted nothing.
  Geometry comes from `useMarginLayout`; card and connector position changes
  animate over 150ms via `.margin-note-pos`, disabled under
  `prefers-reduced-motion`.
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
  so it scrolls with the text. Opens when a highlight, a resolved anchor's
  trace, or a density tick is clicked (or a new comment created) and the rail
  is not drawing that thread; the drawer's own focus-forwarding takes priority
  when the drawer is already open. The gate is `railCanShowThread(id)`, not
  `railShown`: in Anchored density a resolved comment has no card however wide
  the window is, so its popover opens and stays open with the rail up. Closes
  on Escape, an outside click, the rail gaining that card (reopening the
  comment, or switching to List density), `ensureCommentSurface` handing the
  thread to the drawer instead, the view leaving rendered mode, or the active
  file changing.

Every comment focus request (jump-to-next/prev, agent-ask navigation, toast
actions, palette commands) is guaranteed to reach one of these surfaces, rail,
drawer, or popover: never a dead click. Each request carries an origin
(`CommentFocusOrigin` in `useComments.ts`): `'creation'`, `'jump'` (the
default set by `requestCommentFocus`), `'highlight'` for the requests a click
on a highlight, a trace, or a density tick sends into List density, or
`'reveal'` when `ensureCommentSurface` opened a surface to hold the card. In
Anchored density a `'creation'` request (a just-added comment, from
`handleAddComment` in `useComments.ts`) is consumed without activating the
card, so the anchored stack stays put instead of pinning and shoving cards
around the new comment; jump-to-ask, palette jumps, and the review banner's
View action all use the `'jump'` origin and still activate and scroll to the
card. Creating a comment while the rail is hidden still opens the popover
regardless of origin.

Origin also decides whether the card takes DOM focus. `'highlight'` scrolls the
card into view and stops there: a click in the prose means "show me this", the
card is already beside the text, and moving focus out of the document would
send the next space or PageDown to the rail and lift a screen reader out of the
passage. Every other origin names the card deliberately, so the List surface
focuses it (`ThreadCard` carries `tabIndex={-1}` for exactly this).

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

#### Anchor recovery after a rewrite
A comment only reaches "Needs re-anchoring" once **recovery** has failed. A
marker is written immediately before the text it anchors to, so when an edit
rewrites that text but leaves the marker in place, the marker's own position
still points at whatever replaced it. `parseComments` uses that: for any comment
whose `anchor` no longer resolves, it sets `anchorStale: true` and calls
`recoverAnchorAtOffset`, which takes the first line following the marker,
strips leading scaffolding (heading hashes, bullets, blockquote arrows,
ordered-list numbering, table pipes) and inline formatting, and returns it as
`recoveredAnchor` (8 to 120 chars, truncated back to a word boundary). Both
fields are parse-time only and stripped by `serializeComment`.

Five guards keep recovery from attaching a comment to text that is not its own,
each of which produced a wrong anchor before it existed:

- **Relocated markers are not recoverable.** `insertComment` moves a marker out
  of every container that cannot hold one (see "Protected containers"), which
  is precisely the case where it no longer sits before its anchor. Fenced
  blocks and HTML comments are refused by `NON_PROSE_LINE`, since a fence
  delimiter and `<!--` are never visible text. Frontmatter needs its own check:
  it is the one container the marker TRAILS (frontmatter is recognized only at
  offset 0, so there is nowhere above it to go), so the marker parks on the
  closing fence with its anchor behind it and the document's first heading
  ahead. `parseComments` refuses recovery for a marker sitting at the
  frontmatter's end offset, or a comment on a `status:` field silently
  re-points at the page title.

- **The marker's own offset, never `cleanOffset`.** The fuzzy re-match runs
  first and may have moved `cleanOffset` to a guess; its `contextAfter`-only
  fallback rewinds by the OLD anchor's length, which a rewrite is precisely
  what invalidates. Following it lands mid-word in the preceding paragraph.
  `parseComments` keeps the marker positions in a separate map for this.
- **A newline budget.** 0 for a standalone marker (whose own trailing newline
  is stripped, leaving the next line flush against its offset) and 1 for an
  inline marker ending its line. Crossing a blank line means the block is gone
  rather than rewritten, so the comment orphans instead of re-pointing at an
  unrelated later section.
- **Validation through `anchorResolves`.** A candidate that cannot be located
  is worse than none: it suppresses the orphan badge while the viewer
  highlights nothing.
- **Source-only text is refused outright** (`NON_PROSE_LINE`, `HTML_ENTITY`,
  and the cell-separator check). Recovery is the only producer of anchors read
  out of SOURCE text — every other anchor comes from DOM `textContent` — and
  `anchorResolves` compares against source too, so it structurally cannot catch
  a candidate that exists in the source and never in the rendered document.
  Refused: fence delimiters and `|---|` rows (not text), HTML comments (rehype
  drops them), HTML entities (`&amp;` in source, `&` in the DOM), table rows
  (adjacent cells concatenate with NO separator in the DOM, and
  `flexibleIndexOf` requires whitespace between parts, so no readable
  extraction can match), and footnote definitions (rendered into a separate
  Footnotes section). Pipes inside inline code are left alone, since a union
  type is text the reader sees.
- **Live anchors are off limits.** A candidate equal to another comment's
  still-resolving anchor belongs to that comment. Comments clustered on the
  same rewritten block are unaffected, since none of their anchors resolves.

Recovery is what keeps an agent's document restructure from detaching the whole
review at once. It is never silent: the card badges **Re-anchored** in a quiet
style and its `title` carries the original anchor, and `MarkdownViewer`
highlights `recoveredAnchor ?? anchor` so the comment keeps a mark in the
document. A comment with a `recoveredAnchor` is deliberately **not** in
`detectMissingAnchors` — it is attached, just not where it was written. Only a
marker with nothing usable after it (end of file, blank lines, another marker)
stays a true orphan.

`detectMissingAnchors` takes an options bag: `{ includeResolved }` (default
`false`). The rail leaves resolved comments out, since the reviewer cannot act
on them; the card reads `comment.anchorStale` directly and the eval scorer
passes `includeResolved: true` — an agent that
rewrites the document while resolving comments detaches resolved anchors just
as thoroughly, and exempting them reports all-clear on a review whose history
no longer points anywhere. A resolved comment with a stale, unrecovered anchor
gets the quiet **Changed** badge rather than the red one.

Orphan detection is a separate matcher from the viewer's: `detectMissingAnchors`
(`comment-parser.ts`) searches the markdown **source**, where an anchor captured
from rendered text meets syntax the reader never sees. `partsAppearContiguously`
therefore allows structural markdown between anchor words (cell pipes and the
`|:---|` delimiter row, list bullets, blockquote arrows, heading hashes). It
tries a whitespace-only gap first, so an anchor whose own words are punctuation
(a literal `-` between words) is not swallowed by the scaffolding skip. A
selection crossing a table would otherwise be flagged as an orphan the instant
it was saved, even though the viewer highlighted it correctly.

#### Anchor matching tiers
`findMatchRange` (`MarkdownViewer.tsx`) locates an anchor in the concatenated
visible text nodes, in order:

1. Literal match (hint and context aware).
2. Flexible-whitespace match on the original text, hint aware via
   `findFlexibleMatch`. A cross-block anchor carries newlines that the
   concatenated text nodes do not, so this is tier 1 with the whitespace
   loosened. The walk stops at the first match past the offset hint (matches
   come out left to right, so nothing later can be closer) and is capped at
   `MAX_FLEXIBLE_PROBES`, since this tier now runs for every anchor that misses
   a literal match rather than once as a last resort.
3. Stripped-formatting match (`**bold**` → `bold`), literal then flexible.
4. Mermaid node syntax (`E[label]` → `label`), with its own inner fallbacks.

The whole-text tiers must stay ahead of the stripped one. `stripInlineFormatting`
reads markdown source syntax, and an anchor captured from rendered text can carry
something that only looks like syntax: `1. ` opening a heading such as
`## 1. Current Strategy` parses as an ordered-list marker. Matching the stripped
variant first either anchors to "Current Strategy" and silently drops the number
from the highlight, or fails outright and reports the anchor as lost.

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
Clicking a tick jumps to and activates that comment's anchor, then routes the
thread through the same surface decision a highlight click makes
(`revealCommentThread`): usually the card the rail already holds, but a
popover for a resolved comment in Anchored density, where the rail draws no
card. Hidden when there are no anchored comments, in raw view, or while the
diff overlay is showing.

### Section breadcrumb
An inline breadcrumb (`data-section-breadcrumb`) rendered in the panel
toolbar's middle slot (the `breadcrumb` prop on `PanelToolbar`) once the
reader scrolls past the document's first heading. It names the current section
by its full heading chain (e.g. "Requirements > Functional Requirements"),
truncating each segment past 28 characters. Each segment is a button that
jumps to that heading. Hidden in raw view and while the diff overlay is
showing, and disappears again once scrolled back above the first heading.

### Handoff button
`src/components/HandOffButton.tsx` (in the panel toolbar) is md-redline's
"submit review": it copies the agent prompt for the review comments so they
can be handed back to the agent. Its scope follows the **active tab**, never
the whole set of open tabs, because reviewers keep unrelated docs from
different projects open at once and a comment in a background tab must not
light up or rename the button while you read something else. Nothing is
stranded: comments live in the file markers and every tab carries its own
count badge (`tabCommentCounts`), so pending work is surfaced by the tab.

States, driven by the active file's sendable-comment count:
- **Active tab has no sendable comments**: quiet disabled icon with an
  explanatory tooltip, even if other tabs do have comments.
- **Active tab has comments, no other tab does**: labeled CTA; clicking hands
  off the active file immediately.
- **Active tab has comments AND other tabs do**: the CTA (count is always the
  active file) gains a chevron segment that opens a picker. The picker
  pre-selects the active file only and lists other commented tabs unchecked,
  so cross-project tabs are opted in per file rather than assumed to belong to
  this review. The active row is tagged "· this file".

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

### Frontmatter
YAML and TOML frontmatter renders as document content above the first heading
(`.doc-frontmatter`), not hidden the way most renderers treat it. In a review
tool it is content: a skill file's `description` is the text an agent reads to
decide whether to load the skill, an ADR's `status` is a claim worth arguing
with. `remark-rehype` has no handler for `yaml` / `toml` nodes, so
`pipeline.ts` supplies one; keys get a `.doc-frontmatter__key` span for
styling and everything else passes through as text.

The emitted text is byte-identical to the source, fences excluded, and that is
a correctness requirement rather than a style choice. Comments anchor by
searching the raw markdown for the text the DOM handed over, so any
transformation (a prettified key, a stripped quote, a re-wrapped fold) means
`insertComment` can't find the anchor and returns the document unchanged: the
comment vanishes with no marker and no error. Style it with CSS, never by
rewriting the string. `white-space: pre-wrap` is load-bearing for the same
reason.

Commenting on a field works through the normal selection flow. The marker
lands after the closing fence (see Protected containers under Comment format).

Relocation makes `cleanOffset` non-unique: every marker pushed out of the same
container lands on the same offset, so two comments on fields that share a
value (`false` in two booleans) can't be told apart by position. Two things
keep them apart:

- `MarkdownViewer` includes `contextBefore` / `contextAfter` in its highlight
  grouping key, joined on an explicit `\u0000` escape. Grouping runs before
  matching, so a key of offset plus anchor alone collapses the two comments
  into one group and paints a single `<mark>` on the first occurrence. The UI
  always captures context from the selection; the MCP route forwards whatever
  the agent supplied.
- When no context is supplied at all, `insertComment` resolves the anchor to
  its **first** match, since that path has no hint offset. Two such comments
  therefore refer to the same occurrence and sharing one highlight is correct
  rather than a collapse. That invariant is load-bearing: giving the MCP route
  a hint offset without also giving it context would reintroduce the collapse.

Neither is frontmatter-specific: the same collapse reproduces with two comments
on repeated text inside one code fence.

The plain-text offset drift is a red herring here: the two `---` fences stay in
plain space and are absent from the DOM, and the creation path resolves
correctly either way.

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
button still works in edit mode). Frontmatter renders (see Frontmatter above) but is not an
inline edit target; edit it via the raw view.

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
Sidebar view (`Cmd+B`) for browsing and opening markdown files. The panel sizes
itself `flex-1 min-h-0` so a long listing scrolls inside the panel instead of
pushing the settings button out of the sidebar's bottom corner.

**Reveal in explorer.** `revealDirInExplorer(dir, filePath?)` in `App.tsx` backs
both the tab context menu's "Reveal in Explorer Sidebar" and the explorer's
"Open in Explorer" on a directory. It sets the directory, switches the left
panel to Explorer, opens it, and bumps `explorerRevealNonce`. The nonce is what
makes a reveal work when the explorer is already pointed at that directory:
`FileExplorer` re-browses on nonce change, since the panel tracks its own
navigation and the stored directory alone would not have changed.

A reveal applies exactly once. The consumed nonce is recorded the moment the
reveal lands, because `revealPath` stays set afterwards and would otherwise keep
winning every later scroll-into-view and re-flashing its row whenever the active
file changed. Consumption is owned by `App` (`explorerRevealConsumedRef`, seeded
into the panel as `revealConsumedNonce` and reported back via
`onRevealConsumed`) rather than by the panel: `FileExplorer` unmounts on every
sidebar toggle, Outline switch and focus-mode entry, so panel-local state would
resurrect a spent reveal on the next remount. It is a ref, not state, because
recording a consumption must not re-render — that would scroll the panel a
second time, away from the row just revealed. A reveal whose target never appears is retired
when the listing for that file's own directory arrives without it, scoped that
way so a still-in-flight browse of some other directory cannot retire it early.

The revealed row scrolls into view and, when it is not the active file, flashes
briefly. The flash timer lives in its own effect keyed on `flashPath` rather
than in the reveal effect, so an interruption (opening another file mid-flash)
re-arms the timer instead of tearing it down and leaving the row highlighted for
good. A row that is both the reveal target and the active file claims both refs,
so the active-file scroll keeps working after the reveal is spent.

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

Note on templates: the shipped set is `DEFAULT_TEMPLATES` in `src/lib/settings.ts`, ordered so the
two most-used verdicts (`Agreed`, `Rewrite this`) land in the selection pill's one-tap slots.
`parseSettings` runs two migrations, both exact-match only so customized templates are never
touched: pre-2026-07-10 default texts are rewritten in place to drop em-dashes, and a stored list
that still matches the pre-2026-07-28 default set in full is replaced with the current defaults
(that revision added `Agreed` and `Why this?`, dropped `Fix formatting`, and folded `Too vague`
into `Rewrite this`).

### Themes

Light: light, sepia, solarized, github. Dark: dark, nord, rose-pine, catppuccin. System follows OS.
The default light and dark themes use a red-pen palette (warm neutrals, crimson accent).
The document viewer renders on a raised sheet via the `.doc-sheet` class, with the shadow
value supplied per-theme through `--theme-sheet-shadow`. Rendered code blocks (`pre`) and
raw-view fenced code use `--theme-code-text`, falling back to `--theme-text` so that a theme
setting no value renders code at the same strength as the prose around it. No theme
currently overrides it.

Document body copy runs at full ink in every theme and both views: `--tw-prose-body` is
`--theme-text` (not `--theme-text-secondary`), and `.raw-line-content` / `.raw-table` match.
Emphasis is carried by weight, not color: `--tw-prose-bold` falls back to `--theme-text`, so
bold and body are the same color unless a theme opts out. Light themes take that default
unchanged, at the typography plugin's stock 400/600.

The four dark themes opt out, because light-on-dark text blooms: strokes optically thicken,
which compresses the 400/600 gap until bold stops reading as bold. The effect is worse here
than in the sans-set readers that ship weight-only emphasis, since a serif at 600 thickens
its stems but leaves hairlines thin. Dark themes therefore split the difference across both
channels rather than pushing either hard, via four tokens set in each theme's own block:

| Token | Default when unset | Dark themes |
| --- | --- | --- |
| `--theme-prose-bold` | `--theme-text` | one step brighter than `--theme-text` |
| `--theme-prose-body-weight` | 400 | 350 |
| `--theme-prose-bold-weight` | 600 | 780 |
| `--theme-raw-bold-weight` | 600 | 700 |

Measured ink coverage is 1.68x body against 1.19x for stock. Source Serif 4 is a variable
face, so the off-scale weights cost no extra file. Adding a theme therefore needs no changes
outside its own token block: the rules that consume these are unconditional, with the stock
pair as the `var()` fallback, so a theme that sets none of them gets plugin defaults.

`--theme-raw-bold-weight` is separate because the source view is 13px mono, where the
rendered view's 780 is too heavy and its 350 body goes spindly; raw line content stays at
400 in every theme. Counters, bullets, captions, and `.raw-blockquote` track
`--theme-text-secondary` rather than `--theme-text-muted`: muted falls under 3.5:1 on the
Nord, Rosé Pine, and Catppuccin backgrounds, which was tolerable when body was dimmed too
and is not now.

Both weight rules are scoped, and the scoping is load-bearing rather than cosmetic.
Blockquote paragraphs keep the plugin's 500 body weight: that block is italic as a whole,
and italics carry less ink than roman at the same weight, so the plugin pays the difference
back in weight. Inline `em` is deliberately not exempt, since lifting it alone would make
italic phrases heavier than the roman text around them.

Headings are the only block with a `strong` ladder of its own in the plugin (h1 900 down
through h4 700), so `strong` inside `h1`–`h4` is excluded from the body bold weight and
keeps that ladder; applied flat, the rule drags `# Title **bold**` down to 600 inside a 700
heading and renders emphasis *lighter* than the text around it. Blockquotes and `thead th`
are deliberately **not** excluded even though the plugin has `strong` rules for them: those
rules set `color: inherit` only, with no weight, so there is no ladder to defer to and
excluding them leaves bold in a quote or a table header identical to its surroundings.

Comment and selection highlights pin their text to `--theme-text` so it stays legible on the
amber fill. Because bold now sits a step *above* full ink on the dark themes, that pin is
scoped back off `strong`: an anchor covering exactly a bold run nests the `mark` inside the
`<strong>` where the pin would win, while an anchor spilling past it nests the other way, so
without the exception the same phrase renders two different colors depending on how far the
selection ran.

`e2e/prose-emphasis.spec.ts` asserts the dark-theme values by direction (body thinner than
stock, bold heavier and tonally above body) rather than by number, so retuning 350/780/700
does not require editing tests. The plugin's own stock values are asserted literally, since
changing those means the plugin changed under us and the test should say so.
`e2e/drag-regression.spec.ts` covers the reflow side: switching theme or typeface must not
strand the drag handles away from their mark.

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
comment bulk ops (resolve all, clear resolved, delete all, hand off to agent),
active comment ops
(resolve, reopen, delete), heading jump, diagram view (open diagram in fullscreen),
agent asks (jump to next agent question, which shows the pending count and cycles
through questions on repeat invocations).

The bulk ops mirror the rail kebab's gating: resolve-all and clear-resolved need
the resolve workflow on plus a non-zero open / resolved count, and delete-all is
gated on the TOTAL comment count rather than the open count, so it still appears
for a file whose comments are all resolved. Delete-all opens the same
`ConfirmDialog` the rail kebab and list footer use (owned by `App`) instead of
firing immediately.

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
- `detectMissingAnchors(cleanMarkdown, comments, options?)` — find orphaned comments (returns `Set<string>` of comment ids whose anchor text is absent from `cleanMarkdown` and could not be recovered). `options.includeResolved` (default `false`) also checks resolved comments
- `recoverAnchorAtOffset(cleanMarkdown, cleanOffset, newlineBudget)` — derive a replacement anchor from the text following a marker, or `null` when nothing usable follows it. `newlineBudget` is 0 for a standalone marker, 1 for an inline one
- `displayAnchor(comment)` / `anchorSearchText(comment)` (`types.ts`) — the anchor as the reviewer sees it (recovered when stale) and the lowercased search haystack covering both. Anything read, copied, searched, or navigated by should go through these
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
npm run format:check
npm test         # build + unit tests
npm run test:unit
npm run test:e2e
npm run eval:dry
```

Formatting is enforced. CI runs `format:check` before lint, so unformatted
code fails the build; run `npm run format` before pushing. The globs cover
`src`, `server`, `e2e`, `eval`, `scripts`, `bin` and `demo` plus root-level
config, for `.ts`, `.tsx`, `.js` and `.mjs`. Markdown is deliberately excluded
because this file and the README are hand-wrapped, and `bin/md-redline` is
excluded because it has no extension for Prettier to infer a parser from. That
exclusion covers three lines of shim now that the CLI body is `bin/cli.js`.

The repo-wide reformat that introduced this is listed in
`.git-blame-ignore-revs`. GitHub honours that file automatically; locally,
run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git
blame` skips it too.

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

- `eval/fixtures/` currently contains 16 cases.
- Results are written to `eval/results/<timestamp>_<agent>_<format>/`.
- Scoring weights: parsing 20% (markers handled per `markerMode`?), execution 40% (content changes address feedback?), integrity 20% (valid markdown, no malformed markers?), anchorIntegrity 20% (do surviving anchors still resolve?).
- `expected.json` takes an optional `markerMode`: `remove` (default, the original contract, marker deleted once addressed) or `resolve` (marker stays, gains a reply, gets `status: resolved`). Anchor drift only shows up under `resolve`, since a deleted marker takes its anchor with it.
- Agents: `claude-cli` (default, hand-written preamble, remove mode) and `claude-cli-resolve`, which drives the agent with the **shipped** `buildAddressCommentsPrompt` output in resolve mode. Use the latter to keep the real hand-off wording under test, so a regression in it shows up as a score drop rather than in someone's review session.
- `anchorIntegrity` scores each surviving marker: 1 for an anchor that still resolves, 0.5 where only position recovery saved it (the agent rewrote the anchored text without updating the marker), 0 for a detached anchor. Resolved comments are included. Half credit is deliberate: recovery is the app's safety net, not the agent doing its job.
- `16-restructuring-rewrite` is the regression case for that failure — raw notes with anchors quoting them verbatim, and comments that can only be addressed by rewriting those quotes into decisions.

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
