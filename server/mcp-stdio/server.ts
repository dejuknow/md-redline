import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createMdrClient } from './client';
import { handleAskToolCall, handleRequestReviewToolCall, handleReviewToolCall, handleWaitToolCall } from './handler';
import type { RunMcpServerOptions } from './types';
import { validateAskInput, validateRequestReviewInput, validateReviewInput, validateWaitInput } from './validate';

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
          'sees and can reply to in the md-redline UI. Returns with the reply text as soon ' +
          'as the user has answered every question, or with whatever partial replies exist ' +
          'when they finish the review (Done / Finish review), or empty-handed if the ' +
          'session ends another way. Replies also land in the marker threads on disk, so ' +
          'when this tool returns without reply text you should re-read the file(s) before ' +
          'concluding the user did not answer. Use this when a comment is unclear, or when ' +
          'you hit a planning fork while editing. Prefer asking over guessing when the right ' +
          'answer would meaningfully change your edit.\n\n' +
          'Only one mdr_ask can be pending per session at a time. If this returns ' +
          '"a previous mdr_ask is still pending", post a reply to the prior question ' +
          'via mdr_review (with a `replies:` payload targeting that commentId) — that ' +
          'resolves the pending ask in-place — and then retry mdr_ask with your new questions.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'questions'],
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Session ID from a previous mdr_review call, or the sessionId of an ' +
                'active mdr_request_review handoff. Both work: asking a clarifying ' +
                'question about a comment the user left during their own review is ' +
                'the primary use case.',
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
                  author: {
                    type: 'string',
                    description:
                      'Your agent name (e.g. "Claude"). Shown in the mdr UI so users running multiple agents can tell who asked.',
                  },
                  contextBefore: { type: 'string' },
                  contextAfter: { type: 'string' },
                },
              },
            },
          },
        },
      },
      {
        name: 'mdr_review',
        description:
          'Review markdown files in md-redline (mdr) and leave inline feedback. ' +
          'Returns IMMEDIATELY after posting (never blocks). The returned `sessionId` ' +
          'MUST be passed to mdr_wait afterward to block until the user clicks Done — ' +
          'this is a two-tool flow: mdr_review (post) → mdr_wait (block). Skipping ' +
          'mdr_wait leaves a banner on the user\'s screen until they click Done; you ' +
          'will not see their replies or edits before continuing, and any user feedback ' +
          'will be invisible to you for this turn.\n\n' +
          'Use this when the user asks you to review a doc and drop comments. ' +
          'The comments appear as inline markers anchored to specific text, which ' +
          'the user can then address.\n\n' +
          'Comments are anchored to exact text in the rendered document (not the ' +
          'raw markdown). For text inside Mermaid diagrams or markdown-formatted ' +
          'spans, the renderer will fall back to label/stripped matching.\n\n' +
          'Include `author` on each comment/reply identifying yourself (e.g. ' +
          "'Claude', 'Codex', 'Gemini'). This appears in the mdr UI so the user " +
          'knows which agent left the feedback.',
        inputSchema: {
          type: 'object',
          required: ['filePaths'],
          properties: {
            filePaths: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description: 'Absolute paths to markdown files to review.',
            },
            comments: {
              type: 'array',
              items: {
                type: 'object',
                required: ['filePath', 'anchor', 'text'],
                properties: {
                  filePath: { type: 'string' },
                  anchor: { type: 'string', description: 'Exact text in the file the comment refers to.' },
                  text: { type: 'string', description: 'The feedback.' },
                  author: { type: 'string', description: 'Your agent name (e.g. "Claude"). Shown in the mdr UI.' },
                  contextBefore: { type: 'string' },
                  contextAfter: { type: 'string' },
                },
              },
            },
            replies: {
              type: 'array',
              items: {
                type: 'object',
                required: ['filePath', 'commentId', 'text'],
                properties: {
                  filePath: { type: 'string' },
                  commentId: { type: 'string', description: 'ID of an existing top-level comment.' },
                  text: { type: 'string' },
                  author: { type: 'string', description: 'Your agent name (e.g. "Claude"). Shown in the mdr UI.' },
                },
              },
            },
            enableResolve: { type: 'boolean' },
          },
        },
      },
      {
        name: 'mdr_wait',
        description:
          'Block until the user has finished engaging with an mdr_review session. ' +
          'Call this once after you have posted all your feedback batches via mdr_review. ' +
          'Returns when the user clicks Done in the mdr UI. ' +
          'If the wait times out (90s), returns {status:"pending"} — call mdr_wait again ' +
          'with the same sessionId to keep waiting. ' +
          "After this returns {status:\"done\"}, read the file(s) to see the user's " +
          'replies, deletions, and resolutions.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID returned by mdr_review.',
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

    if (request.params.name === 'mdr_review') {
      const validation = validateReviewInput(request.params.arguments);
      if (!validation.ok) throw new Error(`Invalid input: ${validation.error}`);
      const result = await handleReviewToolCall(validation.value, {
        client,
        openInBrowser: opts.openInBrowser,
        baseUrl,
        sendProgress,
        signal,
      });
      return result as CallToolResult;
    }

    if (request.params.name === 'mdr_wait') {
      const validation = validateWaitInput(request.params.arguments);
      if (!validation.ok) throw new Error(`Invalid input: ${validation.error}`);
      const result = await handleWaitToolCall(validation.value, { client, sendProgress, signal });
      return result as CallToolResult;
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
