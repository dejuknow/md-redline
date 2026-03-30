import { describe, expect, it } from 'vitest';
import { ignoreMarkdownHotUpdatePlugin } from './vite.config';

describe('ignoreMarkdownHotUpdatePlugin', () => {
  it('suppresses hot updates for markdown files', () => {
    const plugin = ignoreMarkdownHotUpdatePlugin();
    expect(plugin.handleHotUpdate({ file: '/tmp/spec.md' })).toEqual([]);
    expect(plugin.handleHotUpdate({ file: '/tmp/spec.MD' })).toEqual([]);
  });

  it('leaves non-markdown files alone', () => {
    const plugin = ignoreMarkdownHotUpdatePlugin();
    expect(plugin.handleHotUpdate({ file: '/tmp/spec.ts' })).toBeUndefined();
  });
});
