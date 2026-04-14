import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateRequestReviewInput, createMdrClient } from './mcp-stdio';

describe('mcp-stdio: validateRequestReviewInput', () => {
  it('accepts filePaths for a new session', () => {
    const result = validateRequestReviewInput({ filePaths: ['/tmp/a.md', '/tmp/b.md'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        mode: 'new',
        filePaths: ['/tmp/a.md', '/tmp/b.md'],
        enableResolve: false,
      });
    }
  });

  it('preserves enableResolve when true', () => {
    const result = validateRequestReviewInput({
      filePaths: ['/tmp/a.md'],
      enableResolve: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ mode: 'new', enableResolve: true });
    }
  });

  it('accepts sessionId for continue mode', () => {
    const result = validateRequestReviewInput({ sessionId: 'rev_abc' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ mode: 'continue', sessionId: 'rev_abc' });
    }
  });

  it('rejects missing filePaths and sessionId', () => {
    const result = validateRequestReviewInput({});
    expect(result.ok).toBe(false);
  });

  it('rejects empty filePaths', () => {
    const result = validateRequestReviewInput({ filePaths: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects non-string entries', () => {
    const result = validateRequestReviewInput({ filePaths: ['/tmp/a.md', 123] });
    expect(result.ok).toBe(false);
  });

  it('rejects providing both filePaths and sessionId', () => {
    const result = validateRequestReviewInput({ filePaths: ['/tmp/a.md'], sessionId: 'rev_1' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty sessionId', () => {
    const result = validateRequestReviewInput({ sessionId: '' });
    expect(result.ok).toBe(false);
  });
});

describe('mcp-stdio: createMdrClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('grantAccess POSTs to /api/grant-access for each path', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ granted: '/abs/a.md' }) } as Response);
    const client = createMdrClient('http://localhost:3001');

    await client.grantAccess(['/abs/a.md', '/abs/b.md']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/grant-access',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('createSession POSTs and returns the parsed body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'rev_1', url: '/?review=rev_1' }),
    } as Response);
    const client = createMdrClient('http://localhost:3001');

    const result = await client.createSession({
      filePaths: ['/abs/a.md'],
      enableResolve: false,
    });

    expect(result).toEqual({ sessionId: 'rev_1', url: '/?review=rev_1' });
  });

  it('waitForSession returns the body of GET /wait', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'handed_off', prompt: 'PROMPT' }),
    } as Response);
    const client = createMdrClient('http://localhost:3001');

    const result = await client.waitForSession('rev_1');

    expect(result).toEqual({ status: 'handed_off', prompt: 'PROMPT' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/review-sessions/rev_1/wait',
      expect.any(Object),
    );
  });
});
