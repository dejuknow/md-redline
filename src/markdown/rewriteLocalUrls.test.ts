import { describe, it, expect } from 'vitest';
import { posixDirname, posixResolve, classifyUrl, getExt } from './rewriteLocalUrls';

describe('posixDirname', () => {
  it('returns the parent of a file path', () => {
    expect(posixDirname('/Users/me/notes/file.md')).toBe('/Users/me/notes');
  });

  it('returns "/" for a root file', () => {
    expect(posixDirname('/file.md')).toBe('/');
  });

  it('returns "/" for "/"', () => {
    expect(posixDirname('/')).toBe('/');
  });

  it('handles trailing slash on a directory', () => {
    expect(posixDirname('/Users/me/notes/')).toBe('/Users/me');
  });
});

describe('posixResolve', () => {
  it('resolves a same-directory relative path', () => {
    expect(posixResolve('/Users/me/notes', './file.md')).toBe('/Users/me/notes/file.md');
  });

  it('resolves a parent-directory relative path', () => {
    expect(posixResolve('/Users/me/notes', '../other/file.md')).toBe('/Users/me/other/file.md');
  });

  it('resolves a bare relative path (no leading dot)', () => {
    expect(posixResolve('/Users/me/notes', 'sub/file.md')).toBe('/Users/me/notes/sub/file.md');
  });

  it('collapses multiple "../" segments', () => {
    expect(posixResolve('/a/b/c/d', '../../x.md')).toBe('/a/b/x.md');
  });

  it('does not climb above root', () => {
    expect(posixResolve('/a', '../../../x.md')).toBe('/x.md');
  });

  it('returns absolute paths unchanged', () => {
    expect(posixResolve('/Users/me', '/abs/file.md')).toBe('/abs/file.md');
  });

  it('does not produce an absolute path when base is empty', () => {
    expect(posixResolve('', 'file.md')).toBe('file.md');
  });

  it('handles "." segments', () => {
    expect(posixResolve('/a/b', './c/./d.md')).toBe('/a/b/c/d.md');
  });
});

describe('classifyUrl', () => {
  it('classifies a non-file scheme as external', () => {
    expect(classifyUrl('https://example.com/x.png')).toEqual({ kind: 'external' });
    expect(classifyUrl('mailto:foo@bar')).toEqual({ kind: 'external' });
    expect(classifyUrl('data:image/png;base64,xxx')).toEqual({ kind: 'external' });
    expect(classifyUrl('tel:555')).toEqual({ kind: 'external' });
  });

  it('classifies a pure fragment as fragment', () => {
    expect(classifyUrl('#section')).toEqual({ kind: 'fragment' });
  });

  it('classifies protocol-relative URLs as external', () => {
    expect(classifyUrl('//cdn.example.com/x.png')).toEqual({ kind: 'external' });
  });

  it('classifies file:// URLs as absolute file paths', () => {
    expect(classifyUrl('file:///abs/path/x.png')).toEqual({
      kind: 'absolute',
      path: '/abs/path/x.png',
      fragment: undefined,
    });
  });

  it('classifies file:// URLs with a host as external', () => {
    expect(classifyUrl('file://host/share/x.png')).toEqual({ kind: 'external' });
  });

  it('classifies POSIX-absolute paths as absolute', () => {
    expect(classifyUrl('/Users/me/img.png')).toEqual({
      kind: 'absolute',
      path: '/Users/me/img.png',
      fragment: undefined,
    });
  });

  it('classifies a relative path as relative', () => {
    expect(classifyUrl('./diagram.png')).toEqual({
      kind: 'relative',
      path: './diagram.png',
      fragment: undefined,
    });
    expect(classifyUrl('../assets/logo.svg')).toEqual({
      kind: 'relative',
      path: '../assets/logo.svg',
      fragment: undefined,
    });
    expect(classifyUrl('notes/feedback.md')).toEqual({
      kind: 'relative',
      path: 'notes/feedback.md',
      fragment: undefined,
    });
  });

  it('classifies Windows backslash paths as external (left alone)', () => {
    expect(classifyUrl('C:\\foo\\bar.png')).toEqual({ kind: 'external' });
  });

  it('separates fragment from relative paths', () => {
    expect(classifyUrl('./other.md#intro')).toEqual({
      kind: 'relative',
      path: './other.md',
      fragment: 'intro',
    });
  });

  it('separates fragment from absolute paths', () => {
    expect(classifyUrl('/abs/other.md#intro')).toEqual({
      kind: 'absolute',
      path: '/abs/other.md',
      fragment: 'intro',
    });
  });

  it('strips query strings from relative paths', () => {
    expect(classifyUrl('./img.png?v=2')).toEqual({
      kind: 'relative',
      path: './img.png',
      fragment: undefined,
    });
  });

  it('decodes percent-encoded paths', () => {
    expect(classifyUrl('./my%20file.md')).toEqual({
      kind: 'relative',
      path: './my file.md',
      fragment: undefined,
    });
  });

  it('classifies an empty string as external (leave alone)', () => {
    expect(classifyUrl('')).toEqual({ kind: 'external' });
  });
});

describe('getExt', () => {
  it('returns empty string for a path with no extension', () => {
    expect(getExt('foo')).toBe('');
  });

  it('returns empty string for a dotfile like ".hidden"', () => {
    expect(getExt('.hidden')).toBe('');
  });

  it('returns empty string when the dot is in a directory segment', () => {
    expect(getExt('/foo.bar/baz')).toBe('');
  });

  it('returns the extension lowercased', () => {
    expect(getExt('/foo/bar.PNG')).toBe('.png');
  });

  it('returns the extension for a relative path', () => {
    expect(getExt('./diagram.svg')).toBe('.svg');
  });
});

import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { rewriteLocalUrls } from './rewriteLocalUrls';

function runPlugin(html: string, filePath?: string): string {
  const file = unified()
    .use(rehypeParse, { fragment: true })
    .use(rewriteLocalUrls, { filePath })
    .use(rehypeStringify)
    .processSync(html);
  return String(file);
}

describe('rewriteLocalUrls plugin', () => {
  const FILE = '/Users/me/notes/index.md';

  it('rewrites a relative image src to /api/asset', () => {
    const out = runPlugin('<img src="./diagram.png" alt="d">', FILE);
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/Users/me/notes/diagram.png')}"`,
    );
  });

  it('rewrites a parent-directory relative image src', () => {
    const out = runPlugin('<img src="../assets/logo.svg" alt="l">', FILE);
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/Users/me/assets/logo.svg')}"`,
    );
  });

  it('rewrites a POSIX-absolute image src', () => {
    const out = runPlugin('<img src="/abs/img.png" alt="">', FILE);
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/abs/img.png')}"`,
    );
  });

  it('drops the fragment from an image src', () => {
    const out = runPlugin('<img src="./img.png#small" alt="">', FILE);
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/Users/me/notes/img.png')}"`,
    );
    expect(out).not.toContain('#small');
  });

  it('leaves an https image src unchanged', () => {
    const out = runPlugin('<img src="https://example.com/x.png" alt="">', FILE);
    expect(out).toContain('src="https://example.com/x.png"');
  });

  it('leaves an image with a non-image extension alone', () => {
    const out = runPlugin('<img src="./script.sh" alt="">', FILE);
    expect(out).toContain('src="./script.sh"');
  });

  it('handles uppercase image extensions case-insensitively', () => {
    const out = runPlugin('<img src="./PHOTO.JPG" alt="">', FILE);
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/Users/me/notes/PHOTO.JPG')}"`,
    );
  });

  it('rewrites a relative .md anchor href to data attributes', () => {
    const out = runPlugin('<a href="./other.md">x</a>', FILE);
    expect(out).toContain('href="#"');
    expect(out).toContain(
      `data-mdr-local-md="${'/Users/me/notes/other.md'}"`,
    );
    expect(out).not.toContain('data-mdr-fragment');
  });

  it('preserves the fragment on a .md anchor', () => {
    const out = runPlugin('<a href="./other.md#intro">x</a>', FILE);
    expect(out).toContain('href="#"');
    expect(out).toContain(`data-mdr-local-md="${'/Users/me/notes/other.md'}"`);
    expect(out).toContain('data-mdr-fragment="intro"');
  });

  it('rewrites a POSIX-absolute .md anchor', () => {
    const out = runPlugin('<a href="/abs/other.md">x</a>', FILE);
    expect(out).toContain('href="#"');
    expect(out).toContain('data-mdr-local-md="/abs/other.md"');
  });

  it('handles uppercase .MD case-insensitively', () => {
    const out = runPlugin('<a href="./OTHER.MD">x</a>', FILE);
    expect(out).toContain('data-mdr-local-md="/Users/me/notes/OTHER.MD"');
  });

  it('leaves a non-.md local anchor alone', () => {
    const out = runPlugin('<a href="./script.sh">x</a>', FILE);
    expect(out).toContain('href="./script.sh"');
    expect(out).not.toContain('data-mdr-local-md');
  });

  it('opens an https anchor in a new tab with safe rel', () => {
    const out = runPlugin('<a href="https://example.com">x</a>', FILE);
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('opens an http anchor in a new tab', () => {
    const out = runPlugin('<a href="http://example.com">x</a>', FILE);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('opens a protocol-relative anchor in a new tab', () => {
    const out = runPlugin('<a href="//cdn.example.com/page">x</a>', FILE);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('leaves a mailto anchor in the same tab', () => {
    const out = runPlugin('<a href="mailto:foo@bar.com">x</a>', FILE);
    expect(out).toContain('href="mailto:foo@bar.com"');
    expect(out).not.toContain('target="_blank"');
  });

  it('leaves a tel anchor in the same tab', () => {
    const out = runPlugin('<a href="tel:555-1234">x</a>', FILE);
    expect(out).toContain('href="tel:555-1234"');
    expect(out).not.toContain('target="_blank"');
  });

  it('does not add target=_blank to local .md links', () => {
    const out = runPlugin('<a href="./other.md">x</a>', FILE);
    expect(out).not.toContain('target="_blank"');
  });

  it('leaves a fragment-only anchor unchanged', () => {
    const out = runPlugin('<a href="#section">x</a>', FILE);
    expect(out).toContain('href="#section"');
  });

  it('handles percent-encoded paths', () => {
    const out = runPlugin('<a href="./my%20file.md">x</a>', FILE);
    expect(out).toContain(`data-mdr-local-md="${'/Users/me/notes/my file.md'}"`);
  });

  it('no-ops relative paths when filePath is undefined', () => {
    const out = runPlugin('<img src="./img.png" alt="">');
    expect(out).toContain('src="./img.png"');
  });

  it('still rewrites absolute paths when filePath is undefined', () => {
    const out = runPlugin('<img src="/abs/img.png" alt="">');
    expect(out).toContain(
      `src="/api/asset?path=${encodeURIComponent('/abs/img.png')}"`,
    );
  });

  it('leaves an anchor without href alone', () => {
    const out = runPlugin('<a>just text</a>', FILE);
    expect(out).toContain('<a>just text</a>');
  });

  it('leaves an image without src alone', () => {
    const out = runPlugin('<img alt="">', FILE);
    expect(out).toContain('<img alt="">');
  });
});
