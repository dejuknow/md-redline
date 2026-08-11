import { describe, expect, it } from 'vitest';
import { getParentDir, getPathBasename, middleTruncatePath, tildeShortenPath } from './path-utils';

describe('middleTruncatePath', () => {
  it('leaves a path that already fits alone', () => {
    expect(middleTruncatePath('/tmp/notes', 44)).toBe('/tmp/notes');
  });

  it('elides middle segments and keeps the first and last', () => {
    const long =
      '/private/tmp/claude-503/-Users-dennisju-dev-buela-product-management-designer-jd/1a7f55ac-00f8-4f15-a8b2-4b820badf2a2/scratchpad';
    const out = middleTruncatePath(long, 44);
    expect(out.startsWith('/private/')).toBe(true);
    expect(out.endsWith('/scratchpad')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(44);
  });

  it('keeps as many trailing segments as fit', () => {
    expect(middleTruncatePath('/aaa/bbb/ccc/ddd/eee/fff', 20)).toBe('/aaa/bbb/…/eee/fff');
  });

  it('keeps two leading segments so the path stays placeable', () => {
    const out = middleTruncatePath(
      '/private/tmp/claude-503/-Users-dennisju-dev-buela-product-management-designer-jd/1a7f55ac-00f8-4f15-a8b2-4b820badf2a2/scratchpad',
      44,
    );
    expect(out).toBe('/private/tmp/…/scratchpad');
  });

  it('preserves a tilde-shortened prefix', () => {
    expect(middleTruncatePath('~/dev/some/deeply/nested/place/scratchpad', 24)).toBe(
      '~/dev/…/place/scratchpad',
    );
  });

  it('handles Windows separators', () => {
    expect(middleTruncatePath('C:\\Users\\dennisju\\dev\\projects\\notes', 20)).toBe(
      'C:\\Users\\…\\notes',
    );
  });

  it('never cuts the final segment, even when it alone overflows', () => {
    const out = middleTruncatePath('/a/b/an-extremely-long-single-folder-name-here', 20);
    expect(out).toBe('/…/an-extremely-long-single-folder-name-here');
  });

  it('drops the head rather than blowing the budget on a long leading segment', () => {
    const out = middleTruncatePath('/Volumes/My Passport for Mac 4TB/projects/notes', 28);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.endsWith('/notes')).toBe(true);
  });

  it('stays within budget when every leading segment is oversized', () => {
    const out = middleTruncatePath(`/${'a'.repeat(30)}/${'b'.repeat(30)}/c/d`, 28);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.endsWith('/d')).toBe(true);
  });

  it('keeps both leading slashes on a UNC path', () => {
    expect(middleTruncatePath('\\\\fileserver\\share\\team\\docs\\notes', 28)).toBe(
      '\\\\fileserver\\share\\…\\notes',
    );
  });

  it('returns paths with too few segments unchanged', () => {
    expect(middleTruncatePath('/a-very-long-folder-name-that-overflows', 10)).toBe(
      '/a-very-long-folder-name-that-overflows',
    );
  });
});

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
