#!/usr/bin/env tsx
/**
 * Simulate an AI agent addressing comments in a markdown file.
 *
 * This is a test helper for the diff/comment workflow — instead of handing
 * off to a real agent, run this script to mutate the file in the same ways
 * an agent would: edit content near each comment's anchor, add a reply, and
 * (optionally) resolve the thread.
 *
 * Usage:
 *   tsx scripts/simulate-agent.ts [file] [options]
 *
 * Defaults to sample.md when no file is given.
 *
 * Options:
 *   --reply-only      Add replies but do not edit content or resolve.
 *   --edit-only       Edit content but do not add replies or resolve.
 *   --no-resolve      Edit + reply but leave threads open.
 *   --no-edit         Reply (and optionally resolve) without editing content.
 *   --author=<name>   Author name on the reply (default "Agent").
 *   --dry-run         Print what would change without writing the file.
 *
 * Default behavior (no flags): edit content, add reply, resolve.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseComments,
  addReply,
  resolveComment,
  createCommentMarkerRegex,
} from '../src/lib/comment-parser';
import { getEffectiveStatus } from '../src/types';

/** Knobs that control how the agent mutates each comment. */
export interface SimulationActions {
  edit: boolean;
  reply: boolean;
  resolve: boolean;
  author: string;
}

/** Full CLI option set. Extends actions with CLI-only flags like --dry-run. */
export interface Options extends SimulationActions {
  dryRun: boolean;
}

function parseArgs(argv: string[]): { file: string; opts: Options } {
  const positional: string[] = [];
  const opts: Options = {
    edit: true,
    reply: true,
    resolve: true,
    author: 'Agent',
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--reply-only') {
      opts.edit = false;
      opts.reply = true;
      opts.resolve = false;
    } else if (arg === '--edit-only') {
      opts.edit = true;
      opts.reply = false;
      opts.resolve = false;
    } else if (arg === '--no-resolve') {
      opts.resolve = false;
    } else if (arg === '--no-edit') {
      opts.edit = false;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg.startsWith('--author=')) {
      opts.author = arg.slice('--author='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      printHelp();
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  const file = positional[0] ?? 'sample.md';
  return { file: resolve(process.cwd(), file), opts };
}

function printHelp() {
  console.log(`Usage: tsx scripts/simulate-agent.ts [file] [options]

Simulates an AI agent addressing comments in a markdown file.

Options:
  --reply-only      Add replies but do not edit content or resolve.
  --edit-only       Edit content but do not add replies or resolve.
  --no-resolve      Edit + reply but leave threads open.
  --no-edit         Reply (and optionally resolve) without editing content.
  --author=<name>   Author name on the reply (default "Agent").
  --dry-run         Print what would change without writing the file.
  --help, -h        Show this message.`);
}

/**
 * Pick a canned reply that sounds like an agent acknowledging the feedback.
 * Rotates so multiple comments don't get identical text.
 *
 * Exported for unit testing.
 */
export function makeReply(commentText: string, index: number): string {
  const replies = [
    `Good catch — addressed in the latest revision. ${commentText.slice(0, 40).trim()}...`,
    'Updated to match this requirement. Let me know if the new wording works.',
    'Fixed. I went with the safer/more conservative option you suggested.',
    'Done — see the revised section above. Happy to iterate further.',
    'Thanks for flagging this. Reworked the affected paragraph to address your concern.',
  ];
  return replies[index % replies.length];
}

/**
 * Find the offset of `needle` in `haystack` while skipping any character
 * range covered by `<!-- @comment{...} -->` markers. Without this guard,
 * indexOf() would match the anchor stored inside the marker's JSON payload
 * instead of the body prose, and the diff feature would see no real change
 * (parseComments strips markers before computing the diff).
 *
 * Exported for unit testing.
 */
export function indexOfOutsideMarkers(haystack: string, needle: string): number {
  const re = createCommentMarkerRegex();
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    const insideMarker = ranges.some(([s, e]) => idx >= s && idx < e);
    if (!insideMarker) return idx;
    from = idx + 1;
  }
}

/**
 * Edit the content adjacent to a comment's anchor so the diff feature has
 * something to show. We append a short "[Updated by Agent]" tag the first
 * time the anchor appears in body text (not inside a comment marker), which
 * produces a visible content change without breaking the anchor itself.
 *
 * Exported for unit testing.
 */
export function editNearAnchor(rawMarkdown: string, anchor: string): string {
  if (!anchor) return rawMarkdown;
  const idx = indexOfOutsideMarkers(rawMarkdown, anchor);
  if (idx === -1) return rawMarkdown;
  const before = rawMarkdown.slice(0, idx);
  const after = rawMarkdown.slice(idx + anchor.length);
  return `${before}${anchor} [Updated by Agent]${after}`;
}

/** Exported for unit testing — covers a single comment-by-comment iteration. */
export function applySimulation(content: string, opts: SimulationActions): string {
  const { comments } = parseComments(content);
  const open = comments.filter((c) => getEffectiveStatus(c) === 'open');
  let next = content;
  for (const [i, comment] of open.entries()) {
    if (opts.edit) next = editNearAnchor(next, comment.anchor);
    if (opts.reply) next = addReply(next, comment.id, makeReply(comment.text, i), opts.author);
    if (opts.resolve) next = resolveComment(next, comment.id);
  }
  return next;
}

function main() {
  const { file, opts } = parseArgs(process.argv.slice(2));

  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    console.error(
      `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const { comments } = parseComments(content);
  const open = comments.filter((c) => getEffectiveStatus(c) === 'open');

  if (open.length === 0) {
    console.log(`No open comments in ${file}. Nothing to do.`);
    return;
  }

  console.log(`Simulating agent on ${file}`);
  console.log(`  ${open.length} open comment${open.length === 1 ? '' : 's'}`);
  console.log(
    `  actions: ${[
      opts.edit && 'edit',
      opts.reply && 'reply',
      opts.resolve && 'resolve',
    ]
      .filter(Boolean)
      .join(', ') || '(none)'}`,
  );

  let nextContent = content;

  for (const [i, comment] of open.entries()) {
    console.log(`\n[${i + 1}/${open.length}] ${comment.id}`);
    console.log(`  anchor: ${comment.anchor.slice(0, 60)}`);
    console.log(`  text:   ${comment.text.slice(0, 80)}`);

    if (opts.edit) {
      const before = nextContent;
      nextContent = editNearAnchor(nextContent, comment.anchor);
      if (nextContent === before) {
        console.log('  edit:   anchor not found (skipped)');
      } else {
        console.log('  edit:   appended "[Updated by Agent]" after anchor');
      }
    }

    if (opts.reply) {
      const replyText = makeReply(comment.text, i);
      nextContent = addReply(nextContent, comment.id, replyText, opts.author);
      console.log(`  reply:  ${replyText.slice(0, 70)}`);
    }

    if (opts.resolve) {
      nextContent = resolveComment(nextContent, comment.id);
      console.log('  status: resolved');
    }
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: not writing file');
    return;
  }

  writeFileSync(file, nextContent, 'utf-8');
  console.log(`\nWrote ${file} (${nextContent.length} chars)`);
}

// Only run the CLI when invoked directly. Vitest imports this file for unit
// tests; we don't want it to mutate the user's working directory in that case.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  /simulate-agent\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  main();
}
