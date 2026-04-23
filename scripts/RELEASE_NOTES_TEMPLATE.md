<!-- Instructions for generating md-redline release notes. -->
<!-- AI agents: follow these rules when asked to write release notes. -->

# Release notes format

## Structure

```
## vX.Y.Z

**One sentence about the biggest change.** 2-3 sentences expanding on
what it does and why it matters to users.

Optional line about how to get started (install command, config step).

### Also in this release

- Brief description of change (context if non-obvious)
- Brief description of change
- Brief description of change

**Full Changelog**: https://github.com/dejuknow/md-redline/compare/vPREVIOUS...vX.Y.Z
```

For patch releases, skip the lead paragraph. Just use the bullets.

When a release has several bug fixes alongside improvements, split "Also in this release" into subsections with `#### Improvements` and `#### Bug fixes` subheads. Skip the split when there are only a few bullets or when everything is the same kind of change. Don't prefix individual bullets with labels like "Fix:" or "Improvement:".

## How to gather context

1. Find the previous release tag: `git describe --tags --abbrev=0`
2. List commits since that tag: `git log vPREVIOUS..HEAD --oneline`
3. Read commit messages for features and user-facing fixes.
4. Ignore internal-only changes (test stabilization, CI, refactors, docs reshuffling).

## Writing rules

- Lead sentence: tell users what is NEW. Say what the product does now.
  Good: "md-redline now speaks MCP."
  Bad:  "This release adds MCP support."
- No em dashes. Split into separate sentences instead.
- Keep bullets to one line each. If it needs a paragraph, promote it to the lead.
- Group small fixes into one bullet ("Bug fixes for X, Y, and Z").
- Use plain language. Name the feature, not the implementation detail.
  Good: "Remote images now display correctly"
  Bad:  "Added https: to CSP img-src directive"
- Changelog link uses the GitHub compare URL between the previous tag and the new one.

## Prior examples

### v0.2.0

> **The diff overlay now works in the rendered (prose) view.** Previously
> you could only see what an agent changed in raw mode. Now you can take
> a snapshot, hand off to an agent, and review the resulting edits with
> proper formatting, syntax highlighting, and rendered code fences.
>
> A new unified **panel toolbar** consolidates search, view-mode toggle,
> copy, hand-off, and the diff controls in one place.
>
> ### Also in this release
>
> - Local file navigation between markdown files (relative links open in a new tab)
> - Persistent trusted roots so granted folders are remembered across sessions
> - Automated `npm run release` tooling
> - Two adversarial security review passes (Host header allowlist, file size caps, preferences validation and locking, scheme bypass fix)

### v0.3.0

> **md-redline now speaks MCP.** AI agents can request human review of
> markdown files through a new `mdr_request_review` tool. You leave
> comments in the mdr UI, send them back in batches, and the agent keeps
> iterating. Multiple round-trips per session, multi-file support, and a
> sticky banner that walks you through the whole flow.
>
> Install it once with `md-redline mcp` and it registers globally across
> Claude Code, Cursor, and any MCP-compatible client.
>
> ### Also in this release
>
> - Mermaid diagram labels render as native SVG text with precise comment highlighting (fixes disappearing characters and invisible flowchart labels)
> - Remote images now display correctly (CSP fix)
> - Friendlier upgrade experience (graceful HTTP shutdown, two-line output)
> - Multi-session state isolation so concurrent review sessions don't leak comments across files
