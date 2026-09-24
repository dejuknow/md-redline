import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_ID_LENGTH, resolveClientId } from './client';

describe('resolveClientId', () => {
  it('uses a fresh per-process id when MD_REDLINE_CLIENT_ID is unset or blank', () => {
    for (const env of [{}, { MD_REDLINE_CLIENT_ID: '' }, { MD_REDLINE_CLIENT_ID: '   ' }]) {
      expect(resolveClientId(env)).toMatch(/^mcp_[0-9a-f-]{36}$/);
    }
    expect(resolveClientId({})).not.toBe(resolveClientId({}));
  });

  it('uses the value a per-call client sets, trimmed, so every call shares it', () => {
    expect(resolveClientId({ MD_REDLINE_CLIENT_ID: '  review-42 ' })).toBe('review-42');
  });

  it('accepts the longest value the server accepts and rejects one past it at startup', () => {
    const longest = 'x'.repeat(MAX_CLIENT_ID_LENGTH);
    expect(resolveClientId({ MD_REDLINE_CLIENT_ID: longest })).toBe(longest);
    expect(() => resolveClientId({ MD_REDLINE_CLIENT_ID: `${longest}x` })).toThrow(
      /MD_REDLINE_CLIENT_ID is 257 characters; the limit is 256/,
    );
  });
});
