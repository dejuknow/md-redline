import { describe, expect, it } from 'vitest';

import { buildBrowserUrl, getDisplayHost } from './url-builder.js';

describe('getDisplayHost', () => {
  it('defaults to localhost when MDR_HOST is unset', () => {
    expect(getDisplayHost({})).toBe('localhost');
  });

  it('defaults to localhost when MDR_HOST is empty or whitespace', () => {
    expect(getDisplayHost({ MDR_HOST: '' })).toBe('localhost');
    expect(getDisplayHost({ MDR_HOST: '   ' })).toBe('localhost');
  });

  it('returns the configured hostname when MDR_HOST is set', () => {
    expect(getDisplayHost({ MDR_HOST: 'dev-dsk-myname.us-east-1.amazon.com' })).toBe(
      'dev-dsk-myname.us-east-1.amazon.com',
    );
  });

  it('trims surrounding whitespace from MDR_HOST', () => {
    expect(getDisplayHost({ MDR_HOST: '  example.com  ' })).toBe('example.com');
  });
});

describe('buildBrowserUrl', () => {
  it('renders a localhost URL by default', () => {
    expect(buildBrowserUrl({ port: 5188, env: {} })).toBe('http://localhost:5188');
  });

  it('substitutes MDR_HOST into the URL when set', () => {
    expect(
      buildBrowserUrl({
        port: 5188,
        env: { MDR_HOST: 'dev-dsk-myname.us-east-1.amazon.com' },
      }),
    ).toBe('http://dev-dsk-myname.us-east-1.amazon.com:5188');
  });

  it('encodes file paths into the URL', () => {
    const url = buildBrowserUrl({
      port: 5188,
      file: '/home/user/docs/spec with spaces.md',
      env: {},
    });
    expect(url).toBe(
      'http://localhost:5188?file=%2Fhome%2Fuser%2Fdocs%2Fspec%20with%20spaces.md',
    );
  });

  it('encodes directory paths into the URL', () => {
    const url = buildBrowserUrl({
      port: 5188,
      dir: '/home/user/docs',
      env: {},
    });
    expect(url).toBe('http://localhost:5188?dir=%2Fhome%2Fuser%2Fdocs');
  });

  it('combines MDR_HOST with file paths', () => {
    const url = buildBrowserUrl({
      port: 3001,
      file: '/tmp/spec.md',
      env: { MDR_HOST: 'example.com' },
    });
    expect(url).toBe('http://example.com:3001?file=%2Ftmp%2Fspec.md');
  });

  it('rejects invalid ports', () => {
    expect(() => buildBrowserUrl({ port: 0, env: {} })).toThrow();
    expect(() => buildBrowserUrl({ port: -1, env: {} })).toThrow();
    expect(() => buildBrowserUrl({ port: 65_536, env: {} })).toThrow();
    expect(() => buildBrowserUrl({ port: 3.5, env: {} })).toThrow();
  });
});
