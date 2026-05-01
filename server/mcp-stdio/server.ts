import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createMdrClient } from './client';
import { handleRequestReviewToolCall } from './handler';
import type { RunMcpServerOptions } from './types';
import { validateRequestReviewInput } from './validate';

/**
 * Wire the MCP SDK Server with stdio transport and register the
 * `mdr_request_review` tool. This is the only module that imports
 * from `@modelcontextprotocol/sdk`; the handler and client stay
 * SDK-agnostic for testability.
 */
export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  const server = new Server(
    { name: 'md-redline', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'mdr_request_review',
        description:
          'Open markdown files in mdr (md-redline) for human review, or continue ' +
          'an existing review session. To start a new review, pass filePaths. ' +
          'To continue after addressing a batch of comments, or to re-poll while ' +
          'the user is still reviewing, pass the sessionId from the previous result ' +
          '(without filePaths). If the result says the user has not finished yet, ' +
          'call again with the same sessionId to keep waiting.',
        inputSchema: {
          type: 'object',
          properties: {
            filePaths: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Absolute paths to markdown files to review (for new sessions).',
            },
            enableResolve: {
              type: 'boolean',
              description: 'Whether to use the resolve workflow (open/resolved states).',
            },
            sessionId: {
              type: 'string',
              description:
                'Session ID from a previous batch result. Pass this (without filePaths) ' +
                'to wait for the next batch of comments after addressing the previous batch.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== 'mdr_request_review') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const validation = validateRequestReviewInput(request.params.arguments);
    if (!validation.ok) {
      throw new Error(`Invalid input: ${validation.error}`);
    }

    await opts.ensureServerRunning();
    const baseUrl = opts.getBaseUrl();

    const progressToken = request.params._meta?.progressToken;
    let progressCounter = 0;
    const sendProgress =
      progressToken !== undefined
        ? (message: string) => {
            progressCounter += 1;
            void server
              .notification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: progressCounter,
                  message,
                },
              })
              .catch(() => {
                // Notification failures are non-fatal.
              });
          }
        : undefined;

    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;

    const result = await handleRequestReviewToolCall(validation.value, {
      client: createMdrClient(baseUrl),
      openInBrowser: opts.openInBrowser,
      baseUrl,
      sendProgress,
      signal,
    });
    return result as CallToolResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
