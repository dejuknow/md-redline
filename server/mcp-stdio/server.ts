import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createMdrClient } from './client';
import { handleAskToolCall, handleRequestReviewToolCall } from './handler';
import type { RunMcpServerOptions } from './types';
import { validateAskInput, validateRequestReviewInput } from './validate';

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
          'call again with the same sessionId to keep waiting. ' +
          'IMPORTANT: while this tool is waiting (no "batch" or "done" result has ' +
          'arrived yet, or you are between batches), you do not have permission to ' +
          'read, open, edit, or otherwise act on the files under review using ' +
          'other tools. The user is actively writing @comment markers into those ' +
          'files; reading them yourself will surface unsubmitted markers you must ' +
          'not address. Once a "batch" or "done" result arrives you may read/edit ' +
          'the files, but only to address the comments listed in that result — ' +
          'ignore any other @comment markers you encounter in the file.',
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
      {
        name: 'mdr_ask',
        description:
          'Ask the user one or more questions anchored to specific text in a file ' +
          'inside an active review session. Each question becomes an inline marker the user ' +
          'sees and replies to in the md-redline UI. Blocks until the user has replied to ' +
          'every question or the session aborts. Use this when a comment is unclear, or when ' +
          'you hit a planning fork while editing. Prefer asking over guessing when the right ' +
          'answer would meaningfully change your edit.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'questions'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID from a previous mdr_request_review batch result.',
            },
            questions: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['filePath', 'anchor', 'text'],
                properties: {
                  filePath: { type: 'string', description: 'Absolute path to a file in the session.' },
                  anchor: { type: 'string', description: 'Exact text in the file the question refers to.' },
                  text: { type: 'string', description: 'Your question.' },
                  contextBefore: { type: 'string' },
                  contextAfter: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
    const client = createMdrClient(baseUrl);

    if (request.params.name === 'mdr_request_review') {
      const validation = validateRequestReviewInput(request.params.arguments);
      if (!validation.ok) throw new Error(`Invalid input: ${validation.error}`);
      const result = await handleRequestReviewToolCall(validation.value, {
        client,
        openInBrowser: opts.openInBrowser,
        baseUrl,
        sendProgress,
        signal,
      });
      return result as CallToolResult;
    }

    if (request.params.name === 'mdr_ask') {
      const validation = validateAskInput(request.params.arguments);
      if (!validation.ok) throw new Error(`Invalid input: ${validation.error}`);
      const result = await handleAskToolCall(validation.value, { client, sendProgress, signal });
      return result as CallToolResult;
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
