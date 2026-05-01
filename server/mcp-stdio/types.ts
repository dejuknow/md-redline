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
}

export type WaitResult =
  | { status: 'batch'; prompt: string; commentIds: string[] }
  | { status: 'done'; prompt?: string }
  | { status: 'aborted'; reason: string }
  | { status: 'pending' };

export interface CreateSessionInput {
  filePaths: string[];
  enableResolve: boolean;
}

export interface MdrClient {
  grantAccess(paths: string[]): Promise<void>;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  waitForSession(sessionId: string, timeoutSeconds?: number): Promise<WaitResult>;
  abortSession(sessionId: string): Promise<void>;
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
