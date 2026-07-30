# Contributing to md-redline

Thanks for taking the time. This file covers the things you cannot infer from the
code, so you do not lose an afternoon to them.

`AGENTS.md` is the full reference for architecture, the comment format, the API,
keyboard shortcuts and everything else. It is long because it is a reference, not
a starting point. Read this first, and reach for `AGENTS.md` when you need the
detail on whatever you are actually touching.

## Setup

Node 20 or newer.

```bash
npm install
npm run dev        # server + Vite client + MCP bundle watcher
```

`npm run dev` serves the app at `http://localhost:5188` with the API on `6373`.

## Before you push

`npm run format && npm test`, then `npm run test:e2e` if you touched anything a
browser sees. That is the common case; `.github/workflows/ci.yml` is the authority
on what actually gates a merge, and it is short enough to read.

The one thing worth knowing without reading it: unit tests run on ubuntu, windows
and macos, while everything else runs on Linux only. If you touch process
spawning, path handling or the browser launcher, that matrix is where you will
find out you were wrong, and a green run on your own machine says little about the
other two.

### Four things that will waste your time otherwise

**Formatting gates everything else.** `format:check` runs before lint, so an
unformatted file fails the build before a single test runs. `npm run format` fixes
it. Markdown is excluded on purpose: this file and the README are hand-wrapped.

The exception that will bite you: the format globs match by extension, and
`bin/md-redline` has none, so the main CLI entrypoint is neither formatted nor
checked. Leave its hand-formatting alone. Running `prettier --write bin/md-redline`
reflows the entire file and buries your actual change in a hundred lines of noise.

**`npm run test:unit` needs a current `dist/`.** The MCP stdio tests spawn
`bin/md-redline mcp`, which runs the built bundle. Against a stale `dist/` they
skip themselves rather than fail, so a green summary can hide them entirely. Watch
the skip count. `npm test` runs `build && test:unit` for exactly this reason; if
`mcp-stdio-subprocess` behaves oddly, rebuild before you debug.

**`npx tsc --noEmit` at the repo root checks nothing.** The root `tsconfig.json`
is solution-style (references only), so it exits clean having verified nothing at
all. Use `npx tsc -b`, which is what `npm run build` runs.

**Rebasing after a formatting change is much easier in one specific order.** Run
`npm run format` on your branch and commit that *before* rebasing onto main. Both
sides then hold identical formatting and the whitespace conflicts mostly vanish,
leaving only genuine overlap to resolve.

## Testing expectations

New logic paths need tests. Two lessons from recent work, both learned the
expensive way:

**A regression test must fail without its fix.** Revert the fix, watch the test
go red for the stated reason, then restore. Revert with git (`git stash push --
<file>`) rather than editing the source back by hand: a hand-edit that misses on
whitespace produces a green test that proves nothing.

**Touch behaviour cannot be tested with synthetic events.** A suite that
dispatches `PointerEvent` objects and calls `.click()` will pass with the touch
handlers deleted. `e2e/touch-selection.spec.ts` has the working pattern: a
`test.use({ hasTouch: true })` block driving `page.touchscreen`.

The e2e suite drives a real Chromium and is serialized with one retry, so it is
slow and a single flake costs a full re-run. Run the specs covering your change
while you work, and the whole suite before pushing.

## Docs

`AGENTS.md` is the single source of truth for codebase documentation. If your
change adds a route, a setting, a keyboard shortcut, a theme or a command-palette
entry, update `AGENTS.md` in the same commit. Do not add a parallel doc; do not
put codebase docs in `CLAUDE.md`.

The README is user-facing. Update it when you change something a user configures
or interacts with.

## Conventions

- User-facing environment variables use the `MD_REDLINE_` prefix, a blank value
  counts as unset, and anything read from more than one place gets one shared
  resolver rather than a second inline copy. `AGENTS.md` has the rule, where the
  resolvers live and why, the grandfathered aliases and the exceptions.
- Any route that lets a caller change something must be a `POST` or a `PUT`, the
  two verbs the `application/json` guard checks. A state-changing `GET` is
  reachable from an `<img>` tag in a markdown document the app renders, which is
  untrusted input. `AGENTS.md` has the detail.
- Comments explain why, not what. The repo leans toward fewer, longer comments
  that capture a decision or a non-obvious constraint.

## Opening a PR

Describe what changed and why, and say what you verified. If you tested on real
hardware, say which device and OS: several bugs in this codebase were only ever
reproducible on a real iPad, and that context is worth more than a green CI run.

Small PRs land faster. If you find an unrelated problem on the way, file it
separately rather than folding it in.
