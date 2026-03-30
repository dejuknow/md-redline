import { describe, expect, it } from 'vitest';
import { getPathBasename } from './path-utils';

describe('getPathBasename', () => {
  it('returns the basename for POSIX paths', () => {
    expect(getPathBasename('/tmp/docs/spec.md')).toBe('spec.md');
  });

  it('returns the basename for Windows paths', () => {
    expect(getPathBasename('C:\\docs\\spec.md')).toBe('spec.md');
  });

  it('trims trailing separators before reading the basename', () => {
    expect(getPathBasename('/tmp/docs/')).toBe('docs');
    expect(getPathBasename('C:\\docs\\')).toBe('docs');
  });
});
