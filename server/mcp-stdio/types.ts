/**
 * Shared types for the MCP stdio server module. Kept in their own file so
 * the handler, client, and SDK wiring can import them without forming a
 * dependency cycle.
 */


export type RequestReviewInput =
  | { mode: 'new'; filePaths: string[]; enableResolve: boolean }
  | { mode: 'continue'; sessionId: string };

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface CreateSessionResult {
  sessionId: string;
  url: string;
  /** False when the server returned an existing open session for the same files. */
  created?: boolean;
  /**
   * The session's origin. The server filters dedupe by origin, so a fresh
   * create-or-attach should always return the requested origin. The handler
   * asserts on this defensively so a future server bug doesn't silently
   * attach an agent flow to a user-origin session (the two have incompatible
   * terminal-state semantics).
   */
  origin?: 'user' | 'agent';
}

export type WaitResult =
  | { status: 'batch'; prompt: string; commentIds: string[] }
  | { status: 'done'; prompt?: string }
  | { status: 'aborted'; reason: string }
  | { status: 'pending' };

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
  /** Origin of the session. Defaults to 'user' on the server when omitted. */
  origin?: 'user' | 'agent';
  /**
   * Opaque caller identity scoping server-side dedupe. The client fills
   * this with a process-scoped UUID so two different agents (two MCP
   * server processes) reviewing the same files get distinct sessions.
   */
  clientId?: string;
}

export interface AskQuestion {
  filePath: string;
  anchor: string;
  text: string;
  /** Agent name shown in the mdr UI for this question (e.g. "Claude", "Codex").
   *  Falls back to "Agent" when absent. */
  author?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface AskInput {
  sessionId: string;
  questions: AskQuestion[];
}

import type { AskNoReplyReason } from '../review-sessions';
export type { AskNoReplyReason };

export type AskWaitResult =
  | { status: 'reply'; replies: Array<{ questionIndex: number; text: string }>; totalQuestions: number }
  | { status: 'no_reply'; reason: AskNoReplyReason };

export interface PostAgentCommentsResult {
  askId: string;
}

export interface ReviewComment {
  filePath: string;
  anchor: string;
  text: string;
  author?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface ReviewReply {
  filePath: string;
  commentId: string;
  text: string;
  author?: string;
}

export interface PostReviewArgs {
  comments?: ReviewComment[];
  replies?: ReviewReply[];
  // expectsReply removed — always fire-and-forget
}

export interface ReviewInput {
  filePaths: string[];
  comments?: Array<{ filePath: string; anchor: string; text: string; author?: string; contextBefore?: string; contextAfter?: string }>;
  replies?: Array<{ filePath: string; commentId: string; text: string; author?: string }>;
  enableResolve?: boolean;
}

export interface WaitInput {
  sessionId: string;
}

export type WaitForReviewResult =
  | { status: 'done' }
  | { status: 'pending' }
  /**
   * The session ended without the user explicitly clicking Done — they
   * cancelled, the browser disconnected, the agent timed out (agent_silent),
   * or the agent invoked /finish from the legacy user-batch flow. The agent
   * should treat this as "no engagement" rather than "user finished".
   */
  | { status: 'aborted'; reason: 'user_cancelled' | 'browser_disconnected' | 'agent_silent' | 'finished' };

export interface PostReviewResult {
  askId?: string;
  commentIds?: string[];
  commentsWritten: number;
  repliesWritten: number;
  failedComments?: number[];
  failedReplies?: number[];
}

export interface MdrClient {
  grantAccess(paths: string[]): Promise<void>;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  waitForSession(sessionId: string, timeoutSeconds?: number): Promise<WaitResult>;
  abortSession(sessionId: string): Promise<void>;
  postAgentComments(sessionId: string, questions: AskQuestion[]): Promise<PostAgentCommentsResult>;
  /** Long-poll — intentionally not signal-aware; cancel via releaseAsk instead. */
  waitForAsk(sessionId: string, askId: string): Promise<AskWaitResult>;
  postReview(sessionId: string, args: PostReviewArgs): Promise<PostReviewResult>;
  releaseAsk(sessionId: string, askId: string): Promise<void>;
  /** Long-poll — server's 90s timeout bounds the wait; client doesn't abort the fetch. */
  waitForReview(sessionId: string, timeoutSeconds?: number): Promise<WaitForReviewResult>;
}

export interface ToolCallContext {
  client: MdrClient;
  openInBrowser: (url: string) => Promise<void>;
  baseUrl: string;
  /**
   * Called with a short human-readable status message while the tool call
   * is waiting for the user. The caller is responsible for translating the
   * message into the appropriate MCP protocol shape (e.g. progress
   * notifications). Optional — if absent, no progress updates are sent.
   */
  sendProgress?: (message: string) => void;
  /**
   * Cancellation signal. When the MCP client cancels the tool call, this
   * signal fires and we promptly POST /abort to release the server session
   * so we don't leave a 30-second orphan waiting for the heartbeat sweep.
   */
  signal?: AbortSignal;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface RunMcpServerOptions {
  /**
   * Getter for the web server base URL. Called on every tool call so the
   * bin script can refresh the port after `ensureServerRunning` without any
   * module-level mutable state or ordering concerns.
   */
  getBaseUrl: () => string;
  openInBrowser: (url: string) => Promise<void>;
  ensureServerRunning: () => Promise<void>;
}
