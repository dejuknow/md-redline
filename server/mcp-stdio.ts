/**
 * Barrel for the MCP stdio module. The implementation is split across
 * `server/mcp-stdio/{types,validate,client,handler,server}.ts`; this file
 * re-exports the public surface so existing callers (tests, bin script,
 * dist bundle) keep their imports stable.
 */

export { validateRequestReviewInput, validateContinueReviewInput } from './mcp-stdio/validate';
export { createMdrClient } from './mcp-stdio/client';
export { handleRequestReviewToolCall, handleContinueReviewToolCall } from './mcp-stdio/handler';
export type { ContinueReviewInput } from './mcp-stdio/validate';
export { runMcpServer } from './mcp-stdio/server';
// handleContinueReviewToolCall and validateContinueReviewInput are still
// exported for backward compatibility, but the continue behavior is now
// handled by mdr_request_review with a sessionId parameter.
export type {
  CreateSessionInput,
  CreateSessionResult,
  MdrClient,
  RequestReviewInput,
  RunMcpServerOptions,
  ToolCallContext,
  ToolCallResult,
  ValidationResult,
  WaitResult,
} from './mcp-stdio/types';
