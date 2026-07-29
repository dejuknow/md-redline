import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrast floor for the rendered frontmatter block, checked against every
 * shipped theme.
 *
 * The block's first version used --theme-text-muted on --theme-bg-secondary,
 * which measures 2.18:1 on Solarized and failed AA on six of the eight themes.
 * The prose counters and bullets had already been moved off muted for exactly
 * this reason (see the comment above --tw-prose-counters in index.css), so
 * this was the codebase making the same mistake twice. The guard lives here
 * rather than under src/ because it reads a file off disk, and only the node
 * tsconfig covers that.
 */
const CSS = readFileSync(join(__dirname, '..', 'src', 'index.css'), 'utf-8');

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Theme {
  name: string;
  vars: Record<string, string>;
}

function themeBlocks(): Theme[] {
  const blocks: Theme[] = [];
  const re = /(:root, \[data-theme="light"\]|\[data-theme="[a-z-]+"\])\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(CSS)) !== null) {
    const name = /"([a-z-]+)"/.exec(match[1])?.[1] ?? 'light';
    const vars: Record<string, string> = {};
    for (const v of match[2].matchAll(/--theme-([a-z-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
      vars[v[1]] = v[2];
    }
    if (vars['bg-secondary']) blocks.push({ name, vars });
  }
  return blocks;
}

describe('frontmatter block contrast', () => {
  const themes = themeBlocks();

  it('finds every shipped theme', () => {
    expect(themes.length).toBe(8);
  });

  it.each(themes.map((t) => [t.name, t] as const))('reads legibly on %s', (_name, theme) => {
    // 4.3 is the floor Solarized sets with text-secondary, which is the same
    // ink the app already ships for body copy. Below that is a regression.
    expect(contrast(theme.vars['text-secondary'], theme.vars['bg-secondary'])).toBeGreaterThan(4.3);
    expect(contrast(theme.vars['text'], theme.vars['bg-secondary'])).toBeGreaterThan(4.5);
  });
});
