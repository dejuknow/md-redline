import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrast floors checked against every shipped theme: the rendered
 * frontmatter block here, and ordinary HTML comments further down (#125).
 *
 * The block's first version used --theme-text-muted on --theme-bg-secondary,
 * which measures 2.18:1 on Solarized and failed AA on six of the eight themes.
 * The prose counters and bullets had already been moved off muted for exactly
 * this reason (see the comment above --tw-prose-counters in index.css), so it
 * was the codebase making the same mistake twice.
 *
 * The colours are read out of the `.doc-frontmatter` rule rather than named
 * here. Asserting on --theme-text-secondary by name would pass just as happily
 * after someone set the block back to muted, which is the one regression this
 * file exists to catch. It lives under server/ because it reads a file off
 * disk, and only the node tsconfig covers that.
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

/** Body of a CSS rule, located by its selector. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

/** Which --theme-* variable a property in that rule resolves to. */
function themeVarFor(selector: string, property: string): string {
  // Anchored to line start: an unanchored `color:` also matches inside
  // `background-color:`, which silently reads the background as the ink and
  // makes every contrast ratio 1.
  const match = new RegExp(`\\n\\s*${property}:\\s*var\\(--theme-([a-z-]+)\\)`).exec(
    ruleBody(selector),
  );
  if (!match) throw new Error(`no ${property} in ${selector}`);
  return match[1];
}

describe('frontmatter block contrast', () => {
  const themes = themeBlocks();
  const background = themeVarFor('.doc-frontmatter', 'background-color');
  const valueInk = themeVarFor('.doc-frontmatter', 'color');
  const keyInk = themeVarFor('.doc-frontmatter__key', 'color');

  it('finds every shipped theme', () => {
    expect(themes.length).toBe(8);
  });

  it('reads its colours out of the rule', () => {
    expect(background).toBe('bg-secondary');
    expect(themes[0].vars[valueInk]).toBeTruthy();
    expect(themes[0].vars[keyInk]).toBeTruthy();
  });

  it.each(themes.map((t) => [t.name, t] as const))('reads legibly on %s', (_name, theme) => {
    // 4.3 is the floor Solarized sets with text-secondary, the same ink the app
    // already ships for body copy. Below that is a regression, not a trade-off.
    expect(contrast(theme.vars[valueInk], theme.vars[background])).toBeGreaterThan(4.3);
    expect(contrast(theme.vars[keyInk], theme.vars[background])).toBeGreaterThan(4.5);
  });
});

/**
 * A rule's `color`, resolved against one theme: either a single theme variable
 * or a `color-mix(in srgb, ...)` of two, mixed per channel the way the browser
 * does in srgb. Resolving the mix here keeps the test honest about what the
 * rule actually draws, rather than about which variable it names.
 */
function inkFor(selector: string, theme: Theme): string {
  const body = ruleBody(selector);
  const color = /\n\s*color:\s*([^;]+);/.exec(body)?.[1].trim();
  if (!color) throw new Error(`no color in ${selector}`);
  const single = /^var\(--theme-([a-z-]+)\)$/.exec(color);
  if (single) return theme.vars[single[1]];
  const mixed =
    /^color-mix\(in srgb,\s*var\(--theme-([a-z-]+)\)\s+(\d+)%,\s*var\(--theme-([a-z-]+)\)\)$/.exec(
      color,
    );
  if (!mixed) throw new Error(`unsupported color in ${selector}: ${color}`);
  const share = Number(mixed[2]) / 100;
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = channels(theme.vars[mixed[1]]);
  const b = channels(theme.vars[mixed[3]]);
  return `#${a
    .map((c, i) =>
      Math.round(c * share + b[i] * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Ordinary HTML comments in the rendered view (#125). Their text is body copy,
 * so it needs the 4.5:1 AA minimum on every theme. Its first colour, a mix of
 * text-secondary and text-faint, measured 3.88 on Solarized and 4.06 on GitHub.
 */
/**
 * The ink the `<!--` and `-->` delimiters draw in: the color of any rule that
 * targets the comment's ::before, else the comment's own, which generated
 * content inherits. Found by scanning selector lists, so a rule shared by
 * ::before and ::after counts as well as one for ::before alone.
 */
function delimiterInk(theme: Theme): string {
  for (const rule of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(',').map((sel) => sel.trim());
    if (!selectors.includes('.doc-html-comment::before')) continue;
    const color = /(?:^|\n|;)\s*color:\s*var\(--theme-([a-z-]+)\)/.exec(rule[2]);
    if (color) return theme.vars[color[1]];
  }
  return inkFor('.doc-html-comment', theme);
}

describe('rendered HTML comment contrast', () => {
  const themes = themeBlocks();

  it.each(themes.map((t) => [t.name, t] as const))('comment text reads on %s', (_name, theme) => {
    expect(contrast(inkFor('.doc-html-comment', theme), theme.vars.bg)).toBeGreaterThanOrEqual(4.5);
  });

  // The delimiters are readable syntax: they are what tells a comment apart
  // from the prose around it, so they get the text minimum too, not the 3:1
  // for graphics. In text-faint they measured 1.64 to 2.25.
  it.each(themes.map((t) => [t.name, t] as const))('delimiters read on %s', (_name, theme) => {
    expect(contrast(delimiterInk(theme), theme.vars.bg)).toBeGreaterThanOrEqual(4.5);
  });

  // The raw view colors the whole comment, body and delimiters, with one rule
  // on the same sheet background.
  it.each(themes.map((t) => [t.name, t] as const))(
    'raw view comment reads on %s',
    (_name, theme) => {
      expect(contrast(inkFor('.raw-html-comment', theme), theme.vars.bg)).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );
});
