#!/usr/bin/env tsx
/**
 * Simulate the mdr_ask flow against a running mdr server.
 *
 * Usage:
 *   tsx scripts/simulate-agent-ask.ts <file.md> "anchor text" "question text"
 *
 * Steps:
 *   1. Create a review session for the given file.
 *   2. Open the URL in the browser.
 *   3. POST an agent comment anchored to the given text with the given question.
 *   4. Long-poll on /asks/:askId/wait until the user replies in the UI.
 *   5. Print the reply payload.
 */
import { execSync } from 'child_process';

const baseUrl = process.env.MDR_BASE_URL ?? 'http://localhost:5188';

async function main() {
  const [filePath, anchor, text] = process.argv.slice(2);
  if (!filePath || !anchor || !text) {
    console.error('Usage: tsx scripts/simulate-agent-ask.ts <file.md> "anchor" "question"');
    process.exit(1);
  }

  // Grant access (matches what the MCP layer does).
  await fetchOk(`${baseUrl}/api/grant-access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });

  // Create the session. origin:'agent' matches the production mdr_ask path —
  // user-origin sessions reject /agent-done and /agent-wait, so a simulator
  // that uses agent-side flows must declare itself as agent-origin too.
  const create = await fetchOk(`${baseUrl}/api/review-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePaths: [filePath], origin: 'agent' }),
  });
  const { sessionId, url } = (await create.json()) as { sessionId: string; url: string };
  console.log(`Created session ${sessionId}, opening ${baseUrl}${url}`);
  try {
    execSync(`open '${baseUrl}${url}'`, { stdio: 'ignore' });
  } catch {
    console.log(`Open this URL in your browser: ${baseUrl}${url}`);
  }

  // Post the ask. Explicit mode:'ask' matches the production MCP client and
  // avoids relying on the shape-inference fallback in /agent-comments.
  const ask = await fetchOk(`${baseUrl}/api/review-sessions/${sessionId}/agent-comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'ask', questions: [{ filePath, anchor, text }] }),
  });
  const { askId } = (await ask.json()) as { askId: string };
  console.log(`Posted ask ${askId}; waiting for reply in the UI...`);

  // Long-poll.
  const wait = await fetch(`${baseUrl}/api/review-sessions/${sessionId}/asks/${askId}/wait`);
  const result = await wait.json();
  console.log('Got reply:');
  console.log(JSON.stringify(result, null, 2));
}

async function fetchOk(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${input} failed: HTTP ${res.status} ${body}`);
  }
  return res;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
