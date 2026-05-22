#!/usr/bin/env tsx
/**
 * Simulate the mdr_review flow against a running mdr server.
 *
 * This is a sibling to simulate-agent-ask.ts. Where that script exercises a
 * single anchored question with expectsReply=true, this one exercises the
 * full mdr_review surface: posting multiple synthetic review comments in
 * fire-and-forget, wait, or release modes.
 *
 * Usage:
 *   tsx scripts/simulate-agent-review.ts --file <path.md> [options]
 *
 * Modes:
 *   fire-and-forget  Post comments with expectsReply=false and exit immediately.
 *   wait             Post with expectsReply=true, long-poll for human replies.
 *   release          Post with expectsReply=true, then immediately release the
 *                    ask (simulates the user clicking Release in the UI).
 *
 * Options:
 *   --file <path>               Required. Repeatable for multiple files.
 *   --mode <fire-and-forget|wait|release>
 *                               Default: fire-and-forget.
 *   --count <n>                 Synthetic comment count (default 3).
 *   --server <url>              Default: http://localhost:5188.
 *   --open                      Open session URL in the system browser.
 *   --help, -h                  Show this message.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Mode = 'fire-and-forget' | 'wait' | 'release';

interface Options {
  files: string[];
  mode: Mode;
  count: number;
  server: string;
  open: boolean;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    files: [],
    mode: 'fire-and-forget',
    count: 3,
    server: process.env.MDR_BASE_URL ?? 'http://localhost:5188',
    open: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--file') {
      const val = argv[++i];
      if (!val) die('--file requires a value');
      opts.files.push(resolve(process.cwd(), val));
    } else if (arg.startsWith('--file=')) {
      opts.files.push(resolve(process.cwd(), arg.slice('--file='.length)));
    } else if (arg === '--mode') {
      const val = argv[++i];
      if (!isMode(val)) die(`--mode must be fire-and-forget, wait, or release (got: ${val})`);
      opts.mode = val;
    } else if (arg.startsWith('--mode=')) {
      const val = arg.slice('--mode='.length);
      if (!isMode(val)) die(`--mode must be fire-and-forget, wait, or release (got: ${val})`);
      opts.mode = val;
    } else if (arg === '--count') {
      const val = argv[++i];
      const n = parseInt(val ?? '', 10);
      if (isNaN(n) || n < 1) die('--count must be a positive integer');
      opts.count = n;
    } else if (arg.startsWith('--count=')) {
      const n = parseInt(arg.slice('--count='.length), 10);
      if (isNaN(n) || n < 1) die('--count must be a positive integer');
      opts.count = n;
    } else if (arg === '--server') {
      const val = argv[++i];
      if (!val) die('--server requires a value');
      opts.server = val.replace(/\/$/, '');
    } else if (arg.startsWith('--server=')) {
      opts.server = arg.slice('--server='.length).replace(/\/$/, '');
    } else if (arg === '--open') {
      opts.open = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }

  if (opts.files.length === 0) {
    die('--file <path> is required (pass it once per file)');
  }

  return opts;
}

function isMode(val: string | undefined): val is Mode {
  return val === 'fire-and-forget' || val === 'wait' || val === 'release';
}

function printHelp() {
  console.log(`Usage: tsx scripts/simulate-agent-review.ts --file <path.md> [options]

Simulates an AI agent posting review comments against a running mdr server.

Options:
  --file <path>          Required. Repeatable for multiple files.
  --mode <mode>          fire-and-forget | wait | release  (default: fire-and-forget)
  --count <n>            Number of synthetic comments to generate (default: 3).
  --server <url>         mdr server base URL (default: http://localhost:5188).
                         Also reads MDR_BASE_URL env var.
  --open                 Open the session URL in the system browser.
  --help, -h             Show this message.

Modes:
  fire-and-forget        Post comments with expectsReply=false and exit.
  wait                   Post with expectsReply=true and long-poll for replies.
  release                Post with expectsReply=true, then immediately release.`);
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Anchor extraction
// ---------------------------------------------------------------------------

/**
 * Read a markdown file and pull out up to `n` non-empty, non-heading,
 * non-comment-marker lines to use as comment anchors.
 */
function extractAnchors(filePath: string, n: number): Array<{ filePath: string; anchor: string }> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    die(`Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const anchors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('<!--')) continue;
    if (line.startsWith('```')) continue;
    anchors.push(line.length > 60 ? line.slice(0, 60) : line);
    if (anchors.length >= n) break;
  }

  if (anchors.length === 0) {
    die(`No anchorable lines found in ${filePath}. Make sure the file has plain prose.`);
  }

  // Cycle if the file has fewer unique lines than requested.
  const result: Array<{ filePath: string; anchor: string }> = [];
  for (let i = 0; i < n; i++) {
    result.push({ filePath, anchor: anchors[i % anchors.length] });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Synthetic comment text
// ---------------------------------------------------------------------------

const COMMENT_TEMPLATES = [
  'Consider clarifying this sentence for readers unfamiliar with the background.',
  'This claim needs a source or example to back it up.',
  'The scope here seems broader than intended. Tighten the definition.',
  'Passive voice makes this harder to parse. Who is the actor?',
  'Good point — consider elevating this to a top-level requirement.',
  'This may conflict with the constraint described in the previous section.',
];

function makeCommentText(index: number): string {
  return COMMENT_TEMPLATES[index % COMMENT_TEMPLATES.length];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchOk(input: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach ${input}: ${msg}\nIs the mdr server running?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${input} → HTTP ${res.status}: ${body}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { files, mode, count, server } = opts;

  // Distribute `count` comments across the provided files.
  const allAnchors: Array<{ filePath: string; anchor: string }> = [];
  const perFile = Math.ceil(count / files.length);
  for (const f of files) {
    allAnchors.push(...extractAnchors(f, perFile));
  }
  const comments = allAnchors.slice(0, count).map((a, i) => ({
    filePath: a.filePath,
    anchor: a.anchor,
    text: makeCommentText(i),
  }));

  // 1. Grant access for each file (matches what the MCP layer does).
  for (const f of files) {
    await fetchOk(`${server}/api/grant-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: f }),
    });
    console.log(`Granted access: ${f}`);
  }

  // 2. Create review session (agent-origin, bypasses dedupe).
  const createRes = await fetchOk(`${server}/api/review-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePaths: files, origin: 'agent' }),
  });
  const { sessionId, url } = (await createRes.json()) as { sessionId: string; url: string };
  const sessionUrl = `${server}${url}`;
  console.log(`\nCreated session ${sessionId}`);
  console.log(`  URL: ${sessionUrl}`);

  if (opts.open) {
    try {
      execSync(`open '${sessionUrl}'`, { stdio: 'ignore' });
    } catch {
      console.log(`  (could not auto-open browser)`);
    }
  }

  // 3. Post the synthetic review comments.
  const expectsReply = mode !== 'fire-and-forget';
  console.log(`\nPosting ${comments.length} comment(s) [mode=${mode}, expectsReply=${expectsReply}]`);
  for (const [i, c] of comments.entries()) {
    console.log(`  [${i + 1}] ${c.anchor.slice(0, 50)} — "${c.text.slice(0, 50)}..."`);
  }

  const postRes = await fetchOk(`${server}/api/review-sessions/${sessionId}/agent-comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comments, expectsReply }),
  });
  const postBody = (await postRes.json()) as {
    askId?: string;
    commentIds?: string[];
    commentsWritten?: number;
  };

  console.log(`\nServer response:`);
  console.log(JSON.stringify(postBody, null, 2));

  // 4. Mode-specific follow-up.
  if (mode === 'fire-and-forget') {
    console.log('\nDone (fire-and-forget). Session remains open in the UI.');
    return;
  }

  const askId = postBody.askId;
  if (!askId) {
    throw new Error('Expected askId in server response but got none.');
  }

  if (mode === 'wait') {
    console.log(`\nLong-polling for human reply on ask ${askId}...`);
    console.log('(Open the session URL in your browser and reply to the comments.)');
    console.log(`  ${sessionUrl}`);
    const waitRes = await fetch(`${server}/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    const result = await waitRes.json();
    console.log('\nGot reply:');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'release') {
    console.log(`\nReleasing ask ${askId} immediately (simulating user clicking Release)...`);
    const releaseRes = await fetchOk(
      `${server}/api/review-sessions/${sessionId}/asks/${askId}/release`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    const releaseBody = await releaseRes.json();
    console.log('Release response:');
    console.log(JSON.stringify(releaseBody, null, 2));

    // Also resolve the wait side so we can show what the agent would receive.
    console.log(`\nPolling wait endpoint to confirm release delivery...`);
    const waitRes = await fetch(`${server}/api/review-sessions/${sessionId}/asks/${askId}/wait`);
    const waitBody = await waitRes.json();
    console.log('Wait result:');
    console.log(JSON.stringify(waitBody, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
