import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const BIN = join(__dirname, '..', 'bin', 'md-redline');
const DIST_MCP = join(__dirname, '..', 'dist', 'mcp-stdio.js');

/**
 * Whether the built MCP bundle is current enough to spawn.
 *
 * `mdr mcp` refuses to start on a stale bundle, since it would otherwise run
 * pre-edit code. Existence alone is therefore not enough to decide these tests
 * can run: editing any bundled source without rebuilding leaves a bundle that
 * exists but is rejected, and every test here then burns its 15s ceiling
 * waiting for a subprocess that already exited. Mirror the bin's own rule
 * (bin/md-redline, `mdr mcp bundle is stale`) over the same three roots so the
 * suite skips for the same reason the binary refuses.
 */
function bundleIsRunnable(): boolean {
  let bundleMtime: number;
  try {
    bundleMtime = statSync(DIST_MCP).mtimeMs;
  } catch {
    return false;
  }
  const root = join(__dirname, '..');
  const stack = [join(root, 'server'), join(root, 'src', 'lib'), join(root, 'src', 'types.ts')];
  while (stack.length) {
    const path = stack.pop();
    if (!path) continue;
    let entry;
    try {
      entry = statSync(path);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (entry.isDirectory()) {
      for (const child of readdirSync(path)) stack.push(join(path, child));
    } else if (path.endsWith('.ts')) {
      // Same two filters the bin applies. Test files don't reach the bundle,
      // so editing one must not report staleness — without this, touching any
      // of the ~30 *.test.ts files under these roots silently disables this
      // suite while `mdr mcp` itself would start perfectly well. This file
      // qualifies, which made the check disable itself on its own edit.
      if (path.endsWith('.test.ts') || path.endsWith('.spec.ts')) continue;
      if (entry.mtimeMs > bundleMtime) return false;
    }
  }
  return true;
}

// The bin needs dist/server.js too: its production-mode probe stats that file
// before it will run `mcp` at all.
const HAS_DIST =
  existsSync(DIST_MCP) &&
  existsSync(join(__dirname, '..', 'dist', 'server.js')) &&
  bundleIsRunnable();

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { message: string };
}

function rpcRequest(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function parseResponses(buffer: string): JsonRpcResponse[] {
  return buffer
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as JsonRpcResponse;
      } catch {
        return null;
      }
    })
    .filter((r): r is JsonRpcResponse => r !== null);
}

/**
 * Wait until `predicate(stdoutRef.current)` is truthy OR the ceiling elapses.
 * Polls every 25 ms to keep the test snappy on fast machines without burning
 * CPU, and bails out after `ceilingMs` so the suite fails fast on slow ones.
 */
async function waitFor(
  stdoutRef: { current: string },
  predicate: (parsed: JsonRpcResponse[]) => boolean,
  ceilingMs: number,
): Promise<JsonRpcResponse[]> {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    const parsed = parseResponses(stdoutRef.current);
    if (predicate(parsed)) return parsed;
    await new Promise((r) => setTimeout(r, 25));
  }
  return parseResponses(stdoutRef.current);
}

// Requires dist/mcp-stdio.js — `npm test` builds first, but local
// `vitest run` may not. Skip cleanly so local dev isn't blocked.
(HAS_DIST ? describe : describe.skip)('mdr mcp stdio (subprocess)', () => {
  it('exposes both mdr_request_review and mdr_ask in ListTools', async () => {
    const child = spawn('node', [BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    const stdoutRef = { current: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutRef.current += chunk.toString('utf8');
    });

    try {
      // Send initialize and wait for its response incrementally (no fixed sleep).
      child.stdin.write(
        rpcRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        }),
      );

      const afterInit = await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 1), 5_000);
      const initResp = afterInit.find((r) => r.id === 1);
      expect(
        initResp,
        `initialize response missing; raw stdout:\n${stdoutRef.current}`,
      ).toBeDefined();
      expect(initResp?.result).toBeDefined();

      // Send tools/list and wait for its response.
      child.stdin.write(rpcRequest(2, 'tools/list'));

      const afterList = await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 2), 5_000);
      const toolsResp = afterList.find((r) => r.id === 2);
      expect(
        toolsResp,
        `tools/list response missing; raw stdout:\n${stdoutRef.current}`,
      ).toBeDefined();
      const tools = (toolsResp?.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['mdr_ask', 'mdr_request_review', 'mdr_review', 'mdr_wait']);
    } finally {
      child.kill();
    }
  }, 15_000);

  it('lists mdr_review in tools list', async () => {
    const child = spawn('node', [BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    const stdoutRef = { current: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutRef.current += chunk.toString('utf8');
    });

    try {
      child.stdin.write(
        rpcRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        }),
      );

      await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 1), 5_000);

      child.stdin.write(rpcRequest(2, 'tools/list'));

      const afterList = await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 2), 5_000);
      const toolsResp = afterList.find((r) => r.id === 2);
      expect(
        toolsResp,
        `tools/list response missing; raw stdout:\n${stdoutRef.current}`,
      ).toBeDefined();
      const tools = (toolsResp?.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.find((t) => t.name === 'mdr_review')).toBeDefined();
    } finally {
      child.kill();
    }
  }, 15_000);

  it('advertises mdr_review with an optional sessionId and no required filePaths', async () => {
    // The reported symptom was read straight off this inventory: mdr_review
    // exposed no way to name a session, so every reply batch minted one.
    const child = spawn('node', [BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    const stdoutRef = { current: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutRef.current += chunk.toString('utf8');
    });

    try {
      child.stdin.write(
        rpcRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        }),
      );
      await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 1), 5_000);
      child.stdin.write(rpcRequest(2, 'tools/list'));

      const afterList = await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 2), 5_000);
      const toolsResp = afterList.find((r) => r.id === 2);
      const tools = (
        toolsResp?.result as {
          tools: Array<{
            name: string;
            inputSchema: { properties: Record<string, unknown>; required?: string[] };
          }>;
        }
      ).tools;
      const review = tools.find((t) => t.name === 'mdr_review');
      expect(review).toBeDefined();
      expect(Object.keys(review!.inputSchema.properties)).toContain('sessionId');
      expect(review!.inputSchema.required ?? []).not.toContain('filePaths');
    } finally {
      child.kill();
    }
  }, 15_000);

  it('dispatches mdr_review to handleReviewToolCall', async () => {
    const child = spawn('node', [BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    const stdoutRef = { current: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutRef.current += chunk.toString('utf8');
    });

    try {
      child.stdin.write(
        rpcRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        }),
      );

      await waitFor(stdoutRef, (parsed) => parsed.some((r) => r.id === 1), 5_000);

      child.stdin.write(
        rpcRequest(2, 'tools/call', {
          name: 'mdr_review',
          arguments: {
            filePaths: ['/tmp/test-fixture.md'],
            comments: [{ filePath: '/tmp/test-fixture.md', anchor: 'hello', text: 'feedback' }],
            waitForResponse: false,
          },
        }),
      );

      const afterCall = await waitFor(
        stdoutRef,
        (parsed) => parsed.some((r) => r.id === 2),
        10_000,
      );
      const callResp = afterCall.find((r) => r.id === 2);
      expect(
        callResp,
        `tools/call response missing; raw stdout:\n${stdoutRef.current}`,
      ).toBeDefined();
      // Either a result or an error is acceptable — the key thing is the tool was dispatched
      // (not "Unknown tool: mdr_review"). If there's an error, it should not be about unknown tool.
      if (callResp?.error) {
        expect(callResp.error.message).not.toMatch(/Unknown tool/);
      } else {
        expect(callResp?.result).toBeDefined();
      }
    } finally {
      child.kill();
    }
  }, 15_000);
});
