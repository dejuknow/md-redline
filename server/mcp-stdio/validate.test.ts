import { describe, it, expect } from 'vitest';
import { validateReviewInput } from './validate';

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

  it('accepts waitForResponse as boolean when provided', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
      waitForResponse: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.waitForResponse).toBe(true);
  });

  it('leaves waitForResponse undefined when omitted', () => {
    const res = validateReviewInput({
      filePaths: ['/tmp/a.md'],
      comments: [{ filePath: '/tmp/a.md', anchor: 'hi', text: 't' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.waitForResponse).toBeUndefined();
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
});
