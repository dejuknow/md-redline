import type { RequestReviewInput, ValidationResult } from './types';

export interface ContinueReviewInput {
  sessionId: string;
}

export function validateContinueReviewInput(raw: unknown): ValidationResult<ContinueReviewInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'input must be an object' };
  }
  const obj = raw as { sessionId?: unknown };
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  return { ok: true, value: { sessionId: obj.sessionId } };
}

/**
 * Validate a raw tool-call argument object against the expected
 * RequestReviewInput shape. Accepts either:
 *   - { filePaths, enableResolve? } for a new review session
 *   - { sessionId } to continue an existing session (re-poll for next batch)
 */
export function validateRequestReviewInput(raw: unknown): ValidationResult<RequestReviewInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'input must be an object' };
  }
  const obj = raw as { filePaths?: unknown; enableResolve?: unknown; sessionId?: unknown };

  // Continue mode: sessionId is provided
  if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) {
    if (Array.isArray(obj.filePaths) && obj.filePaths.length > 0) {
      return { ok: false, error: 'provide either filePaths or sessionId, not both' };
    }
    return { ok: true, value: { mode: 'continue', sessionId: obj.sessionId } };
  }

  // New session mode: filePaths is required
  if (!Array.isArray(obj.filePaths)) {
    return { ok: false, error: 'filePaths must be an array (or provide sessionId to continue a session)' };
  }
  if (obj.filePaths.length === 0) {
    return { ok: false, error: 'filePaths must be non-empty' };
  }
  if (obj.filePaths.some((p) => typeof p !== 'string' || p.length === 0)) {
    return { ok: false, error: 'filePaths must contain non-empty strings' };
  }

  return {
    ok: true,
    value: {
      mode: 'new',
      filePaths: obj.filePaths as string[],
      enableResolve: obj.enableResolve === true,
    },
  };
}
