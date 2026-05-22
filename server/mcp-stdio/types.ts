/**
 * Shared types for the MCP stdio server module. Kept in their own file so
 * the handler, client, and SDK wiring can import them without forming a
 * dependency cycle.
 */

import type { AppSettings } from '../preferences';

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
}

export interface AskQuestion {
  filePath: string;
  anchor: string;
  text: string;
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
  | { status: 'reply'; replies: Array<{ questionIndex: number; text: string }> }
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
  expectsReply: boolean;
}

export interface ReviewInput {
  filePaths: string[];
  comments?: Array<{ filePath: string; anchor: string; text: string; author?: string; contextBefore?: string; contextAfter?: string }>;
  replies?: Array<{ filePath: string; commentId: string; text: string; author?: string }>;
  waitForResponse?: boolean;
  enableResolve?: boolean;
}

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
  waitForAsk(sessionId: string, askId: string): Promise<AskWaitResult>;
  postReview(sessionId: string, args: PostReviewArgs): Promise<PostReviewResult>;
  releaseAsk(sessionId: string, askId: string): Promise<void>;
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
  /**
   * Read the current user settings (preferences). Used by handleReviewToolCall
   * to resolve defaultAgentReviewWait when waitForResponse is omitted.
   * Optional — if absent, defaults to fire-and-forget (expectsReply=false).
   */
  getUserSettings?: () => Promise<AppSettings>;
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
  /**
   * Read the current user settings. If provided, handleReviewToolCall uses
   * defaultAgentReviewWait to determine expectsReply when waitForResponse is
   * omitted from the tool input. Defaults to fire-and-forget when absent.
   */
  getUserSettings?: () => Promise<AppSettings>;
}
