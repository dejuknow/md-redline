import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const BIN = join(__dirname, '..', 'bin', 'md-redline');
const DIST_MCP = join(__dirname, '..', 'dist', 'mcp-stdio.js');
const HAS_DIST = existsSync(DIST_MCP);

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
  it('responds to initialize and tools/list with the mdr_request_review tool', async () => {
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

      const afterInit = await waitFor(
        stdoutRef,
        (parsed) => parsed.some((r) => r.id === 1),
        5_000,
      );
      const initResp = afterInit.find((r) => r.id === 1);
      expect(initResp, `initialize response missing; raw stdout:\n${stdoutRef.current}`).toBeDefined();
      expect(initResp?.result).toBeDefined();

      // Send tools/list and wait for its response.
      child.stdin.write(rpcRequest(2, 'tools/list'));

      const afterList = await waitFor(
        stdoutRef,
        (parsed) => parsed.some((r) => r.id === 2),
        5_000,
      );
      const toolsResp = afterList.find((r) => r.id === 2);
      expect(toolsResp, `tools/list response missing; raw stdout:\n${stdoutRef.current}`).toBeDefined();
      const tools = (toolsResp?.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain('mdr_request_review');
      expect(tools.map((t) => t.name)).not.toContain('mdr_continue_review');
    } finally {
      child.kill();
    }
  }, 15_000);
});
