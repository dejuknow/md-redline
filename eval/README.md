# Eval Harness

This directory contains the regression harness for the core `md-redline` workflow:

1. an agent reads a markdown file with inline `<!-- @comment{...} -->` markers
2. it edits the document content to address open feedback
3. it removes addressed markers
4. the harness scores the result against deterministic expectations

This is not a UI test suite and not a general model benchmark. It is a task-specific check for how well an agent handles inline markdown review comments.

## Commands

```bash
npm run eval
npm run eval:dry
```

- `npm run eval:dry`
  Validates fixture structure only. It checks that each case has a readable `input.md`, `prompt.txt`, and valid `expected.json`. It does not call the agent and does not write scored results.
- `npm run eval`
  Runs the full harness, invokes the configured agent adapter on each case, scores the output, and writes results under `eval/results/<timestamp>_<agent>_<format>/`.

## Case Structure

Each case lives in its own directory under `eval/fixtures/`:

```text
eval/fixtures/<case-name>/
  input.md
  prompt.txt
  expected.json
```

- `input.md`
  The markdown document given to the agent. It may contain inline comment markers, threaded replies, resolved comments, frontmatter, tables, code blocks, or overlapping anchors.
- `prompt.txt`
  The per-case instruction layered on top of the adapter's system prompt.
- `expected.json`
  The deterministic scoring contract for the case.

The expectation schema is defined in [types.ts](./types.ts).

## What It Tests

The current fixtures cover the main document-editing scenarios this app cares about:

- direct rewrites of vague or underspecified text
- overlapping comment anchors
- comment markers attached to code blocks
- deletion requests
- threaded comments and reply context
- larger documents with multiple comments
- files with no comments
- YAML frontmatter preservation
- mixed open and resolved comments
- clustered comments inside a single paragraph
- markdown table edits

The harness evaluates document-level behavior, not UI behavior. It does not test selection UX, rendering, keyboard shortcuts, or browser interactions.

## Run Flow

For each case, [runner.ts](./runner.ts) does the following:

1. discover fixture directories under `eval/fixtures/`
2. load `input.md`, `prompt.txt`, and `expected.json`
3. transform the input to the selected format variant
4. write that transformed input to a temp file
5. invoke the configured agent adapter on that temp file
6. read the edited file back from disk
7. transform the output back to the current format
8. score the result
9. write per-case scores and a run summary to `eval/results/`

## Scoring

Scoring is implemented in [scorer.ts](./scorer.ts). The overall score is weighted across three dimensions:

- `parsing` 25%
  Checks whether actionable comment markers were removed after the agent addressed them.
- `execution` 50%
  Checks whether the edited document content satisfies the case assertions in `expected.json`.
- `integrity` 25%
  Checks whether any remaining markers are still valid JSON with required fields.

The scoring is deterministic. It does not ask another model to judge quality. It uses marker presence plus substring assertions such as:

- content that should contain specific text
- content that should not contain specific text
- whether the clean markdown should change at all

## Agent And Model

The runner supports pluggable agent adapters, but the current registry only includes the adapter id `claude-cli` in [runner.ts](./runner.ts).

That adapter is implemented in [agents/claude-cli.ts](./agents/claude-cli.ts). It shells out to the local `claude` CLI and:

- creates a temp working directory
- copies the case input into `input.md`
- prepends a system prompt that explains the inline comment format and required behavior
- shells out to the local `claude` CLI with `Read`, `Edit`, and `Write` tool access
- reads the edited file back from disk

Important: the adapter does not pass an explicit model flag to `claude`. The effective model is whatever your local Claude CLI is configured to use by default at runtime.

## Formats

The runner also supports format adapters, but the current registry only includes `current` in [formats/index.ts](./formats/index.ts). That format is a passthrough for the current inline marker format used by this app.

## CLI Flags

The runner supports these flags:

- `-c`, `--case`
  Run only cases whose directory name includes the provided substring.
- `-a`, `--agent`
  Select the agent adapter. Current default and only built-in option: `claude-cli`.
- `-f`, `--format`
  Select the format adapter. Current default and only built-in option: `current`.
- `--dry-run`
  Validate fixtures without invoking the agent.
- `-v`, `--verbose`
  Print detailed scoring output for each case.

Examples:

```bash
npm run eval
npm run eval -- --dry-run
npm run eval -- --case overlapping
npm run eval -- --verbose
```

## Results

Each full run writes a timestamped directory under `eval/results/`:

```text
eval/results/<timestamp>_<agent>_<format>/
  summary.json
  <case-name>/
    scores.json
```

- `summary.json`
  Aggregate metadata plus all case scores for the run.
- `<case-name>/scores.json`
  Per-case scoring details.

The harness currently saves scores and summaries, not the edited markdown outputs themselves.
