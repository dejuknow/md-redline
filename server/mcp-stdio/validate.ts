import type { AskInput, RequestReviewInput, ValidationResult } from './types';

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

export function validateAskInput(raw: unknown): ValidationResult<AskInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'input must be an object' };
  }
  const obj = raw as { sessionId?: unknown; questions?: unknown };
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array' };
  }
  for (let i = 0; i < obj.questions.length; i++) {
    const raw = obj.questions[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `questions[${i}] must be an object` };
    }
    const q = raw as {
      filePath?: unknown;
      anchor?: unknown;
      text?: unknown;
      contextBefore?: unknown;
      contextAfter?: unknown;
    };
    if (typeof q.filePath !== 'string' || q.filePath.length === 0) {
      return { ok: false, error: `questions[${i}].filePath must be a non-empty string` };
    }
    if (typeof q.anchor !== 'string' || q.anchor.length === 0) {
      return { ok: false, error: `questions[${i}].anchor must be a non-empty string` };
    }
    if (typeof q.text !== 'string' || q.text.length === 0) {
      return { ok: false, error: `questions[${i}].text must be a non-empty string` };
    }
    if (q.contextBefore !== undefined && typeof q.contextBefore !== 'string') {
      return { ok: false, error: `questions[${i}].contextBefore must be a string if present` };
    }
    if (q.contextAfter !== undefined && typeof q.contextAfter !== 'string') {
      return { ok: false, error: `questions[${i}].contextAfter must be a string if present` };
    }
  }
  return {
    ok: true,
    value: {
      sessionId: obj.sessionId,
      questions: obj.questions as AskInput['questions'],
    },
  };
}
