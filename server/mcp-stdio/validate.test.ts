import { describe, it, expect } from 'vitest';
import { validateAskInput, validateReviewInput, validateWaitInput } from './validate';

describe('validateReviewInput', () => {
  it('accepts comments-only input', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
    });
    expect(res.ok).toBe(true);
  });

  it('accepts replies-only input', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      replies: [{ filePath: '/tmp/a.md', commentId: 'cmt_1', text: 'r' }],
    });
    expect(res.ok).toBe(true);
  });

  it('rejects when both comments and replies are empty', () => {
    const res = validateReviewInput({ filePaths: ['/tmp/a.md'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/comments or replies/);
  });

  it('rejects comment filePath not in filePaths', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/other.md', anchor: 'hi', text: 't' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not in filePaths/);
  });

  it('silently ignores waitForResponse if a stale client sends it', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
      waitForResponse: true,
    });
    expect(res.ok).toBe(true);
    // waitForResponse is no longer part of ReviewInput; the field must not appear
    if (res.ok) expect(Object.keys(res.value)).not.toContain('waitForResponse');
  });

  it('rejects empty filePaths', () => {
    const res = validateReviewInput({
      filePaths: [],
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects malformed comment shape', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md' }],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects oversize comment anchor (DoS guard)', () => {
    const huge = 'x'.repeat(8 * 1024 + 1);
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: huge, text: 't' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/anchor.*maximum/);
  });

  it('rejects oversize reply text', () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      replies: [{ filePath: '/tmp/a.md', commentId: 'cmt_1', text: huge }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/text.*maximum/);
  });
});

describe('validateAskInput', () => {
  const validQuestion = { filePath: '/tmp/a.md', anchor: 'hi', text: 'q?' };

  it('accepts a valid ask payload', () => {
    const res = validateAskInput({ sessionId: 'rev_x', questions: [validQuestion] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.sessionId).toBe('rev_x');
      expect(res.value.questions).toHaveLength(1);
    }
  });

  it('accepts optional author / contextBefore / contextAfter', () => {
    const res = validateAskInput({
      sessionId: 'rev_x',
      questions: [{ ...validQuestion, author: 'Claude', contextBefore: 'before', contextAfter: 'after' }],
    });
    expect(res.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const res = validateAskInput('rev_x');
    expect(res.ok).toBe(false);
  });

  it('rejects missing sessionId', () => {
    const res = validateAskInput({ questions: [validQuestion] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/sessionId/);
  });

  it('rejects empty sessionId', () => {
    const res = validateAskInput({ sessionId: '', questions: [validQuestion] });
    expect(res.ok).toBe(false);
  });

  it('rejects empty questions array', () => {
    const res = validateAskInput({ sessionId: 'rev_x', questions: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/non-empty/);
  });

  it('rejects question with non-string filePath', () => {
    const res = validateAskInput({ sessionId: 'rev_x', questions: [{ ...validQuestion, filePath: 42 }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/filePath/);
  });

  it('rejects question with empty anchor', () => {
    const res = validateAskInput({ sessionId: 'rev_x', questions: [{ ...validQuestion, anchor: '' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/anchor/);
  });

  it('rejects non-string author', () => {
    const res = validateAskInput({
      sessionId: 'rev_x',
      questions: [{ ...validQuestion, author: 42 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/author/);
  });

  it('rejects non-string contextBefore', () => {
    const res = validateAskInput({
      sessionId: 'rev_x',
      questions: [{ ...validQuestion, contextBefore: 42 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/contextBefore/);
  });

  it('rejects non-object element in questions array', () => {
    const res = validateAskInput({ sessionId: 'rev_x', questions: ['not-an-object'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/must be an object/);
  });

  it('rejects oversize anchor (DoS guard)', () => {
    const huge = 'x'.repeat(8 * 1024 + 1);
    const res = validateAskInput({
      sessionId: 'rev_x',
      questions: [{ ...validQuestion, anchor: huge }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/anchor.*maximum/);
  });

  it('rejects oversize text', () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    const res = validateAskInput({
      sessionId: 'rev_x',
      questions: [{ ...validQuestion, text: huge }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/text.*maximum/);
  });
});

describe('validateWaitInput', () => {
  it('accepts a valid sessionId', () => {
    const res = validateWaitInput({ sessionId: 'rev_abc123' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.sessionId).toBe('rev_abc123');
  });

  it('rejects missing sessionId', () => {
    const res = validateWaitInput({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/sessionId/);
  });

  it('rejects empty sessionId', () => {
    const res = validateWaitInput({ sessionId: '' });
    expect(res.ok).toBe(false);
  });

  it('rejects non-string sessionId', () => {
    const res = validateWaitInput({ sessionId: 42 });
    expect(res.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    const res = validateWaitInput('rev_abc');
    expect(res.ok).toBe(false);
  });
});
