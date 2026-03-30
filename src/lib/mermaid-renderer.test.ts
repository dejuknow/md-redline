import { describe, it, expect } from 'vitest';
import { getMermaidTheme, hasMermaidBlocks } from './mermaid-renderer';
import { ALL_THEMES } from './themes';

describe('getMermaidTheme', () => {
  it('maps "light" to "default"', () => {
    expect(getMermaidTheme('light')).toBe('default');
  });

  it('maps "dark" to "dark"', () => {
    expect(getMermaidTheme('dark')).toBe('dark');
  });

  it('maps "sepia" to "neutral"', () => {
    expect(getMermaidTheme('sepia')).toBe('neutral');
  });

  it('maps "nord" to "dark"', () => {
    expect(getMermaidTheme('nord')).toBe('dark');
  });

  it('maps "rose-pine" to "dark"', () => {
    expect(getMermaidTheme('rose-pine')).toBe('dark');
  });

  it('maps "solarized" to "default"', () => {
    expect(getMermaidTheme('solarized')).toBe('default');
  });

  it('maps "github" to "default"', () => {
    expect(getMermaidTheme('github')).toBe('default');
  });

  it('maps "catppuccin" to "dark"', () => {
    expect(getMermaidTheme('catppuccin')).toBe('dark');
  });

  it('falls back to "default" for unknown themes', () => {
    expect(getMermaidTheme('unknown-theme')).toBe('default');
    expect(getMermaidTheme('')).toBe('default');
  });

  it('returns a valid mermaid theme for every app theme in themes.ts', () => {
    const validMermaidThemes = ['default', 'dark', 'forest', 'neutral', 'base'];
    for (const theme of ALL_THEMES) {
      const result = getMermaidTheme(theme.key);
      expect(
        validMermaidThemes.includes(result),
        `getMermaidTheme("${theme.key}") returned "${result}" — add it to THEME_MAP in mermaid-renderer.ts`,
      ).toBe(true);
    }
  });
});

describe('hasMermaidBlocks', () => {
  it('returns true when markdown contains a mermaid code block', () => {
    expect(hasMermaidBlocks('# Title\n\n```mermaid\ngraph TD\nA-->B\n```\n')).toBe(true);
  });

  it('returns true when mermaid block is at the start', () => {
    expect(hasMermaidBlocks('```mermaid\nflowchart LR\n```')).toBe(true);
  });

  it('returns false when no mermaid blocks exist', () => {
    expect(hasMermaidBlocks('# Title\n\n```js\nconst x = 1;\n```\n')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasMermaidBlocks('')).toBe(false);
  });

  it('returns false for inline mermaid mention', () => {
    expect(hasMermaidBlocks('Use mermaid for diagrams')).toBe(false);
  });

  it('returns false when mermaid is not at line start', () => {
    expect(hasMermaidBlocks('  ```mermaid\ngraph TD\n```')).toBe(false);
  });
});
