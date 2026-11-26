import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './cli-args.js';

describe('parseCliArgs', () => {
  it('separates flags from the positional target regardless of order', () => {
    expect(parseCliArgs(['--browser', 'notes.md'])).toEqual({
      noOpen: false,
      forceBrowser: true,
      positional: 'notes.md',
      unknownOption: null,
    });
    expect(parseCliArgs(['notes.md', '--browser'])).toEqual({
      noOpen: false,
      forceBrowser: true,
      positional: 'notes.md',
      unknownOption: null,
    });
  });

  it('parses --no-open with no positional', () => {
    expect(parseCliArgs(['--no-open'])).toEqual({
      noOpen: true,
      forceBrowser: false,
      positional: '',
      unknownOption: null,
    });
  });

  it('treats everything after -- as positional, keeping dash filenames reachable', () => {
    const result = parseCliArgs(['--browser', '--', '-notes.md']);
    expect(result.forceBrowser).toBe(true);
    expect(result.positional).toBe('-notes.md');
    expect(result.unknownOption).toBeNull();
  });

  it('reports unknown dash-args instead of silently ignoring them', () => {
    expect(parseCliArgs(['--bogus', 'notes.md']).unknownOption).toBe('--bogus');
    // Known-but-first-arg-only options reaching the parser are also reported.
    expect(parseCliArgs(['notes.md', '--stop']).unknownOption).toBe('--stop');
  });

  it('returns an empty positional for no args and takes the first of several', () => {
    expect(parseCliArgs([]).positional).toBe('');
    expect(parseCliArgs(['a.md', 'b.md']).positional).toBe('a.md');
  });
});
