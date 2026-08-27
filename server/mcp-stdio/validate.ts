import type {
  AskInput,
  RequestReviewInput,
  ReviewInput,
  ValidationResult,
  WaitInput,
} from './types';

// Hard caps on agent-controlled string fields. Anchors, text bodies, and
// context fields end up persisted into the user's markdown file and parsed
// on every load; an adversarial or buggy agent posting megabyte-scale
// strings would freeze the renderer and bloat the file. Caps are generous
// for legitimate use (rich reasoning text up to 64KB per comment) but
// short enough to prevent catastrophic DoS.
const MAX_ANCHOR_LEN = 8 * 1024;
const MAX_TEXT_LEN = 64 * 1024;
const MAX_CONTEXT_LEN = 8 * 1024;

function bounded(field: string, value: string, max: number): string | null {
  return value.length > max
    ? `${field} exceeds maximum length of ${max} chars (got ${value.length})`
    : null;
}

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
    return {
      ok: false,
      error: 'filePaths must be an array (or provide sessionId to continue a session)',
    };
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

/**
 * Validate a raw mdr_comment argument object. Accepts either:
 *   - { filePaths, enableResolve? } to create-or-attach an agent-origin session
 *   - { sessionId } to post into a session that already exists
 *
 * In the filePaths form, every comment/reply filePath must appear in
 * filePaths. In the sessionId form there is no such list to check against,
 * and the server enforces the stronger condition anyway: it rejects any path
 * outside the named session's own filePaths.
 */
export function validateReviewInput(raw: unknown): ValidationResult<ReviewInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'input must be an object' };
  }
  const obj = raw as {
    filePaths?: unknown;
    sessionId?: unknown;
    comments?: unknown;
    replies?: unknown;
    enableResolve?: unknown;
  };

  // Presence selects the form, NOT validity. Deciding on validity lets a
  // malformed sessionId fall through to the create form, which mints exactly
  // the duplicate session this parameter exists to prevent -- silently, and
  // only when filePaths happens to be supplied too.
  // `undefined` is the only absence: it is what an omitted JSON key and an
  // explicitly-undefined JS property both produce. `null` is a value the
  // caller chose to send, so it lands in the invalid-sessionId branch below
  // rather than quietly selecting the create form.
  const hasSessionId = obj.sessionId !== undefined;
  if (hasSessionId && (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0)) {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  // Presence again, not non-emptiness: `filePaths: []` beside a sessionId is
  // still a caller asking for both forms at once.
  if (hasSessionId && obj.filePaths !== undefined) {
    return { ok: false, error: 'provide either filePaths or sessionId, not both' };
  }
  // Rejected rather than dropped, for the same reason filePaths is: an
  // existing session keeps the resolve mode it was created with, so honouring
  // the flag is impossible and ignoring it silently misleads the caller.
  if (hasSessionId && obj.enableResolve !== undefined) {
    return {
      ok: false,
      error:
        'enableResolve applies to the filePaths form only; an existing session ' +
        'keeps the resolve mode it was created with',
    };
  }

  // `filePathsSet` scopes the per-item filePath check below. Null in
  // sessionId mode, where the check is skipped entirely.
  let filePathsSet: Set<string> | null = null;
  if (!hasSessionId) {
    if (obj.filePaths === undefined) {
      return {
        ok: false,
        error:
          'provide filePaths to open a session, or sessionId to post into one ' +
          'that already exists',
      };
    }
    if (!Array.isArray(obj.filePaths) || obj.filePaths.length === 0) {
      return { ok: false, error: 'filePaths must be a non-empty array' };
    }
    if (obj.filePaths.some((p) => typeof p !== 'string' || p.length === 0)) {
      return { ok: false, error: 'filePaths must contain non-empty strings' };
    }
    filePathsSet = new Set(obj.filePaths as string[]);
  }

  const hasComments = Array.isArray(obj.comments) && obj.comments.length > 0;
  const hasReplies = Array.isArray(obj.replies) && obj.replies.length > 0;
  if (!hasComments && !hasReplies) {
    return { ok: false, error: 'comments or replies must be a non-empty array' };
  }

  if (hasComments) {
    for (let i = 0; i < (obj.comments as unknown[]).length; i++) {
      const c = (obj.comments as Array<Record<string, unknown>>)[i];
      if (
        typeof c.filePath !== 'string' ||
        typeof c.anchor !== 'string' ||
        typeof c.text !== 'string'
      ) {
        return { ok: false, error: `comments[${i}]: filePath, anchor, text required as strings` };
      }
      if (!c.anchor || !c.text || !c.filePath) {
        return { ok: false, error: `comments[${i}]: filePath, anchor, text must be non-empty` };
      }
      if (filePathsSet !== null && !filePathsSet.has(c.filePath as string)) {
        return { ok: false, error: `comments[${i}].filePath not in filePaths` };
      }
      if (c.author !== undefined && typeof c.author !== 'string') {
        return { ok: false, error: `comments[${i}].author must be a string if present` };
      }
      if (c.contextBefore !== undefined && typeof c.contextBefore !== 'string') {
        return { ok: false, error: `comments[${i}].contextBefore must be a string if present` };
      }
      if (c.contextAfter !== undefined && typeof c.contextAfter !== 'string') {
        return { ok: false, error: `comments[${i}].contextAfter must be a string if present` };
      }
      const tooLong =
        bounded(`comments[${i}].anchor`, c.anchor as string, MAX_ANCHOR_LEN) ||
        bounded(`comments[${i}].text`, c.text as string, MAX_TEXT_LEN) ||
        (typeof c.contextBefore === 'string' &&
          bounded(`comments[${i}].contextBefore`, c.contextBefore, MAX_CONTEXT_LEN)) ||
        (typeof c.contextAfter === 'string' &&
          bounded(`comments[${i}].contextAfter`, c.contextAfter, MAX_CONTEXT_LEN));
      if (tooLong) return { ok: false, error: tooLong };
    }
  }

  if (hasReplies) {
    for (let i = 0; i < (obj.replies as unknown[]).length; i++) {
      const r = (obj.replies as Array<Record<string, unknown>>)[i];
      if (
        typeof r.filePath !== 'string' ||
        typeof r.commentId !== 'string' ||
        typeof r.text !== 'string'
      ) {
        return { ok: false, error: `replies[${i}]: filePath, commentId, text required as strings` };
      }
      if (!r.commentId || !r.text || !r.filePath) {
        return { ok: false, error: `replies[${i}]: fields must be non-empty` };
      }
      if (filePathsSet !== null && !filePathsSet.has(r.filePath as string)) {
        return { ok: false, error: `replies[${i}].filePath not in filePaths` };
      }
      if (r.author !== undefined && typeof r.author !== 'string') {
        return { ok: false, error: `replies[${i}].author must be a string if present` };
      }
      const tooLong = bounded(`replies[${i}].text`, r.text as string, MAX_TEXT_LEN);
      if (tooLong) return { ok: false, error: tooLong };
    }
  }

  const payload = {
    comments: hasComments ? (obj.comments as ReviewInput['comments']) : undefined,
    replies: hasReplies ? (obj.replies as ReviewInput['replies']) : undefined,
  };

  if (hasSessionId) {
    return { ok: true, value: { ...payload, sessionId: obj.sessionId as string } };
  }
  return {
    ok: true,
    value: {
      ...payload,
      filePaths: obj.filePaths as string[],
      enableResolve: obj.enableResolve === true ? true : undefined,
    },
  };
}

export function validateWaitInput(raw: unknown): ValidationResult<WaitInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'input must be an object' };
  }
  const obj = raw as { sessionId?: unknown };
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  return { ok: true, value: { sessionId: obj.sessionId } };
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
      author?: unknown;
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
    if (q.author !== undefined && typeof q.author !== 'string') {
      return { ok: false, error: `questions[${i}].author must be a string if present` };
    }
    if (q.contextBefore !== undefined && typeof q.contextBefore !== 'string') {
      return { ok: false, error: `questions[${i}].contextBefore must be a string if present` };
    }
    if (q.contextAfter !== undefined && typeof q.contextAfter !== 'string') {
      return { ok: false, error: `questions[${i}].contextAfter must be a string if present` };
    }
    const tooLong =
      bounded(`questions[${i}].anchor`, q.anchor as string, MAX_ANCHOR_LEN) ||
      bounded(`questions[${i}].text`, q.text as string, MAX_TEXT_LEN) ||
      (typeof q.contextBefore === 'string' &&
        bounded(`questions[${i}].contextBefore`, q.contextBefore, MAX_CONTEXT_LEN)) ||
      (typeof q.contextAfter === 'string' &&
        bounded(`questions[${i}].contextAfter`, q.contextAfter, MAX_CONTEXT_LEN));
    if (tooLong) return { ok: false, error: tooLong };
  }
  return {
    ok: true,
    value: {
      sessionId: obj.sessionId,
      questions: obj.questions as AskInput['questions'],
    },
  };
}
