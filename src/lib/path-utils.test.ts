import { describe, expect, it } from 'vitest';
import { getParentDir, getPathBasename, tildeShortenPath } from './path-utils';

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

describe('tildeShortenPath', () => {
  it('replaces a leading POSIX home dir prefix with ~', () => {
    expect(tildeShortenPath('/Users/dennisju/dev/temp', '/Users/dennisju')).toBe('~/dev/temp');
  });

  it('returns the path unchanged when it does not start with the home dir', () => {
    expect(tildeShortenPath('/tmp/scratch.md', '/Users/dennisju')).toBe('/tmp/scratch.md');
  });

  it('returns just ~ when the path equals the home dir', () => {
    expect(tildeShortenPath('/Users/dennisju', '/Users/dennisju')).toBe('~');
  });

  it('returns the path unchanged when home dir is empty', () => {
    expect(tildeShortenPath('/Users/dennisju/dev', '')).toBe('/Users/dennisju/dev');
  });

  it('returns the path unchanged when path is empty', () => {
    expect(tildeShortenPath('', '/Users/dennisju')).toBe('');
  });

  it('handles a trailing slash on the home dir', () => {
    expect(tildeShortenPath('/Users/dennisju/dev', '/Users/dennisju/')).toBe('~/dev');
  });

  it('does not match a path that merely contains the home dir as a substring', () => {
    expect(tildeShortenPath('/var/Users/dennisju', '/Users/dennisju')).toBe('/var/Users/dennisju');
  });

  it('does not match a path that starts with the home dir but lacks a separator boundary', () => {
    expect(tildeShortenPath('/Users/dennisjustmore', '/Users/dennisju')).toBe(
      '/Users/dennisjustmore',
    );
  });

  it('replaces a leading Windows-style home dir prefix with ~', () => {
    expect(tildeShortenPath('C:\\Users\\dennisju\\dev', 'C:\\Users\\dennisju')).toBe('~\\dev');
  });
});

describe('getParentDir', () => {
  it('returns the directory for a POSIX path', () => {
    expect(getParentDir('/Users/dennis/docs/spec.md')).toBe('/Users/dennis/docs');
  });

  it('returns the root for a file directly under it', () => {
    expect(getParentDir('/spec.md')).toBe('/');
  });

  it('handles Windows separators', () => {
    expect(getParentDir('C:\\docs\\spec.md')).toBe('C:\\docs');
  });

  it('keeps the separator on a drive root', () => {
    expect(getParentDir('C:\\spec.md')).toBe('C:\\');
  });

  it('returns an empty string when there is no directory part', () => {
    expect(getParentDir('spec.md')).toBe('');
    expect(getParentDir('')).toBe('');
  });

  it('ignores a trailing separator', () => {
    expect(getParentDir('/Users/dennis/docs/')).toBe('/Users/dennis');
  });
});
