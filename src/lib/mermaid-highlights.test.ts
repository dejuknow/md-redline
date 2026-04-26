// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  applyMermaidHighlightStyles,
  applyMermaidSvgTextHighlight,
  formatPathCommands,
  formatTranslateTransform,
  getMermaidHighlightTheme,
  parsePathCommands,
  parsePolygonPoints,
  parseTranslateTransform,
  parseViewBox,
  pointInPolygon,
  transformPathY,
} from './mermaid-highlights';

describe('parseTranslateTransform', () => {
  it('parses "translate(10, 20)" with comma separator', () => {
    expect(parseTranslateTransform('translate(10, 20)')).toEqual({
      x: 10,
      y: 20,
      suffix: '',
    });
  });

  it('parses "translate(10 20) scale(2)" with space separator and suffix', () => {
    expect(parseTranslateTransform('translate(10 20) scale(2)')).toEqual({
      x: 10,
      y: 20,
      suffix: 'scale(2)',
    });
  });

  it('returns null for non-translate transforms', () => {
    expect(parseTranslateTransform('scale(2)')).toBeNull();
    expect(parseTranslateTransform('rotate(45)')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseTranslateTransform(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTranslateTransform('')).toBeNull();
  });

  it('handles negative numbers', () => {
    expect(parseTranslateTransform('translate(-15, -25.5)')).toEqual({
      x: -15,
      y: -25.5,
      suffix: '',
    });
  });

  it('handles scientific notation numbers', () => {
    expect(parseTranslateTransform('translate(1e2, 2.5e-1)')).toEqual({
      x: 100,
      y: 0.25,
      suffix: '',
    });
  });

  it('handles positive sign prefix', () => {
    expect(parseTranslateTransform('translate(+10, +20)')).toEqual({
      x: 10,
      y: 20,
      suffix: '',
    });
  });

  it('handles decimal numbers without leading digit', () => {
    expect(parseTranslateTransform('translate(.5, .75)')).toEqual({
      x: 0.5,
      y: 0.75,
      suffix: '',
    });
  });
});

describe('formatTranslateTransform', () => {
  it('formats { x: 10, y: 20, suffix: "" } to "translate(10, 20)"', () => {
    expect(formatTranslateTransform({ x: 10, y: 20, suffix: '' })).toBe('translate(10, 20)');
  });

  it('appends suffix when present', () => {
    expect(formatTranslateTransform({ x: 5, y: 15, suffix: 'scale(2)' })).toBe(
      'translate(5, 15) scale(2)',
    );
  });

  it('round-trips through parse and format', () => {
    const input = 'translate(42.5, -10.3)';
    const parsed = parseTranslateTransform(input);
    expect(parsed).not.toBeNull();
    expect(formatTranslateTransform(parsed!)).toBe('translate(42.5, -10.3)');
  });

  it('round-trips with suffix', () => {
    const input = 'translate(10, 20) scale(0.5)';
    const parsed = parseTranslateTransform(input);
    expect(parsed).not.toBeNull();
    expect(formatTranslateTransform(parsed!)).toBe('translate(10, 20) scale(0.5)');
  });
});

describe('parsePolygonPoints', () => {
  it('parses "10,20 30,40" to point array', () => {
    expect(parsePolygonPoints('10,20 30,40')).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('returns empty array for null', () => {
    expect(parsePolygonPoints(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parsePolygonPoints('')).toEqual([]);
  });

  it('filters out malformed pairs', () => {
    expect(parsePolygonPoints('10,20 bad 30,40')).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('handles multiple whitespace separators', () => {
    expect(parsePolygonPoints('  10,20   30,40   50,60  ')).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ]);
  });

  it('parses negative coordinates', () => {
    expect(parsePolygonPoints('-10,-20 30,-40')).toEqual([
      { x: -10, y: -20 },
      { x: 30, y: -40 },
    ]);
  });
});

describe('pointInPolygon', () => {
  // Unit square: (0,0), (10,0), (10,10), (0,10)
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('returns true for a point inside a square polygon', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
  });

  it('returns false for a point outside', () => {
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: -1 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 11 }, square)).toBe(false);
  });

  it('returns true for a point near the center of a triangle', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 3 }, triangle)).toBe(true);
  });

  it('returns false for a point clearly outside a triangle', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    expect(pointInPolygon({ x: 0, y: 10 }, triangle)).toBe(false);
  });

  it('returns false for an empty polygon', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, [])).toBe(false);
  });
});

describe('parsePathCommands', () => {
  it('parses "M0 0L10 20" into commands', () => {
    expect(parsePathCommands('M0 0L10 20')).toEqual([
      { cmd: 'M', values: [0, 0] },
      { cmd: 'L', values: [10, 20] },
    ]);
  });

  it('handles C (cubic bezier) commands', () => {
    const result = parsePathCommands('C10 20 30 40 50 60');
    expect(result).toEqual([{ cmd: 'C', values: [10, 20, 30, 40, 50, 60] }]);
  });

  it('handles S (smooth cubic) commands', () => {
    const result = parsePathCommands('S10 20 30 40');
    expect(result).toEqual([{ cmd: 'S', values: [10, 20, 30, 40] }]);
  });

  it('handles Q (quadratic) commands', () => {
    const result = parsePathCommands('Q10 20 30 40');
    expect(result).toEqual([{ cmd: 'Q', values: [10, 20, 30, 40] }]);
  });

  it('handles V (vertical line) commands', () => {
    const result = parsePathCommands('V100');
    expect(result).toEqual([{ cmd: 'V', values: [100] }]);
  });

  it('handles H (horizontal line) commands', () => {
    const result = parsePathCommands('H200');
    expect(result).toEqual([{ cmd: 'H', values: [200] }]);
  });

  it('handles Z (close path) with no values', () => {
    const result = parsePathCommands('M0 0L10 10Z');
    expect(result).toEqual([
      { cmd: 'M', values: [0, 0] },
      { cmd: 'L', values: [10, 10] },
      { cmd: 'Z', values: [] },
    ]);
  });

  it('handles A (arc) commands', () => {
    const result = parsePathCommands('A25 25 0 0 1 50 75');
    expect(result).toEqual([{ cmd: 'A', values: [25, 25, 0, 0, 1, 50, 75] }]);
  });

  it('handles negative numbers in path data', () => {
    const result = parsePathCommands('M-10 -20L30 -40');
    expect(result).toEqual([
      { cmd: 'M', values: [-10, -20] },
      { cmd: 'L', values: [30, -40] },
    ]);
  });

  it('handles scientific notation in path data', () => {
    const result = parsePathCommands('M1e2 2.5e-1');
    expect(result).toEqual([{ cmd: 'M', values: [100, 0.25] }]);
  });

  it('parses complex multi-command paths', () => {
    const result = parsePathCommands('M10 20L30 40C50 60 70 80 90 100Z');
    expect(result).toHaveLength(4);
    expect(result[0].cmd).toBe('M');
    expect(result[1].cmd).toBe('L');
    expect(result[2].cmd).toBe('C');
    expect(result[3].cmd).toBe('Z');
  });
});

describe('formatPathCommands', () => {
  it('formats commands back to a path string', () => {
    const commands = [
      { cmd: 'M', values: [0, 0] },
      { cmd: 'L', values: [10, 20] },
    ];
    expect(formatPathCommands(commands)).toBe('M0 0L10 20');
  });

  it('formats Z with no values', () => {
    const commands = [
      { cmd: 'M', values: [0, 0] },
      { cmd: 'Z', values: [] },
    ];
    expect(formatPathCommands(commands)).toBe('M0 0Z');
  });

  it('round-trips with parsePathCommands', () => {
    const original = 'M10 20L30 40C50 60 70 80 90 100Z';
    const parsed = parsePathCommands(original);
    const formatted = formatPathCommands(parsed);
    // Re-parse to verify equivalence (whitespace may differ)
    expect(parsePathCommands(formatted)).toEqual(parsed);
  });

  it('round-trips a complex path with arcs', () => {
    const original = 'M0 0A25 25 0 0 1 50 75L100 200Z';
    const parsed = parsePathCommands(original);
    const formatted = formatPathCommands(parsed);
    expect(parsePathCommands(formatted)).toEqual(parsed);
  });
});

describe('transformPathY', () => {
  const addTen = (y: number) => y + 10;

  it('transforms M command Y values', () => {
    const result = transformPathY('M0 5', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([0, 15]);
  });

  it('transforms L command Y values', () => {
    const result = transformPathY('M0 0L10 20', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([0, 10]); // M: y 0 -> 10
    expect(parsed[1].values).toEqual([10, 30]); // L: y 20 -> 30
  });

  it('transforms C command Y values at indices 1, 3, 5', () => {
    const result = transformPathY('C10 20 30 40 50 60', addTen);
    const parsed = parsePathCommands(result);
    // indices 1, 3, 5 should have +10
    expect(parsed[0].values).toEqual([10, 30, 30, 50, 50, 70]);
  });

  it('transforms S command Y values at indices 1 and 3', () => {
    const result = transformPathY('S10 20 30 40', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([10, 30, 30, 50]);
  });

  it('transforms Q command Y values at indices 1 and 3', () => {
    const result = transformPathY('Q10 20 30 40', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([10, 30, 30, 50]);
  });

  it('transforms V command values', () => {
    const result = transformPathY('V50', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([60]);
  });

  it('transforms A command Y value at index 6', () => {
    const result = transformPathY('A25 25 0 0 1 50 75', addTen);
    const parsed = parsePathCommands(result);
    // Only index 6 (the final Y) should be transformed
    expect(parsed[0].values).toEqual([25, 25, 0, 0, 1, 50, 85]);
  });

  it('returns original path for relative (lowercase) commands', () => {
    const input = 'm0 5l10 20';
    expect(transformPathY(input, addTen)).toBe(input);
  });

  it('returns original path when mix of absolute and relative commands', () => {
    const input = 'M0 5l10 20';
    expect(transformPathY(input, addTen)).toBe(input);
  });

  it('does not transform H command values (horizontal)', () => {
    const result = transformPathY('H100', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[0].values).toEqual([100]); // H is unchanged
  });

  it('does not transform Z command', () => {
    const result = transformPathY('M0 0L10 10Z', addTen);
    const parsed = parsePathCommands(result);
    expect(parsed[2].cmd).toBe('Z');
    expect(parsed[2].values).toEqual([]);
  });
});

describe('parseViewBox', () => {
  it('parses "0 0 100 200"', () => {
    expect(parseViewBox('0 0 100 200')).toEqual({
      minX: 0,
      minY: 0,
      width: 100,
      height: 200,
    });
  });

  it('parses with comma separators', () => {
    expect(parseViewBox('10,20,300,400')).toEqual({
      minX: 10,
      minY: 20,
      width: 300,
      height: 400,
    });
  });

  it('parses negative min values', () => {
    expect(parseViewBox('-50 -100 500 600')).toEqual({
      minX: -50,
      minY: -100,
      width: 500,
      height: 600,
    });
  });

  it('returns null for null input', () => {
    expect(parseViewBox(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseViewBox('')).toBeNull();
  });

  it('returns null for too few values', () => {
    expect(parseViewBox('0 0 100')).toBeNull();
  });

  it('returns null for too many values', () => {
    expect(parseViewBox('0 0 100 200 300')).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    expect(parseViewBox('a b c d')).toBeNull();
  });

  it('handles extra whitespace', () => {
    expect(parseViewBox('  0   0   100   200  ')).toEqual({
      minX: 0,
      minY: 0,
      width: 100,
      height: 200,
    });
  });

  it('parses fractional values', () => {
    expect(parseViewBox('0.5 1.5 200.25 300.75')).toEqual({
      minX: 0.5,
      minY: 1.5,
      width: 200.25,
      height: 300.75,
    });
  });
});

describe('getMermaidHighlightTheme', () => {
  it('reads CSS custom properties from rootStyles', () => {
    const properties: Record<string, string> = {
      '--theme-comment-bg-opaque': '#fff3cd',
      '--theme-comment-bg-hover-opaque': '#ffeaa7',
      '--theme-text': '#212529',
      '--theme-comment-underline': '#f0ad4e',
      '--theme-comment-underline-active': '#e08e0b',
      '--theme-comment-ring': '#fd7e14',
    };

    const mockStyles = {
      getPropertyValue: (prop: string) => properties[prop] ?? '',
    } as CSSStyleDeclaration;

    const theme = getMermaidHighlightTheme(mockStyles);
    expect(theme).toEqual({
      background: '#fff3cd',
      activeBackground: '#ffeaa7',
      color: '#212529',
      underline: '#f0ad4e',
      activeUnderline: '#e08e0b',
      ring: '#fd7e14',
    });
  });

  it('falls back for missing active/hover properties', () => {
    const properties: Record<string, string> = {
      '--theme-comment-bg-opaque': '#fff3cd',
      '--theme-text': '#212529',
      '--theme-comment-underline': '#f0ad4e',
      '--theme-comment-ring': '#fd7e14',
    };

    const mockStyles = {
      getPropertyValue: (prop: string) => properties[prop] ?? '',
    } as CSSStyleDeclaration;

    const theme = getMermaidHighlightTheme(mockStyles);
    expect(theme.activeBackground).toBe('#fff3cd'); // falls back to background
    expect(theme.activeUnderline).toBe('#f0ad4e'); // falls back to underline
  });
});

describe('applyMermaidHighlightStyles', () => {
  const theme = {
    background: '#fff3cd',
    activeBackground: '#ffeaa7',
    color: '#212529',
    underline: '#f0ad4e',
    activeUnderline: '#e08e0b',
    ring: '#fd7e14',
  };

  it('sets expected inline styles for active=true', () => {
    const el = document.createElement('span');
    applyMermaidHighlightStyles(el, theme, true);

    // jsdom normalizes hex to rgb(), so compare against normalized values
    expect(el.style.backgroundColor).toBe('rgb(255, 234, 167)'); // activeBackground
    expect(el.style.backgroundImage).toBe('none');
    expect(el.style.color).toBe('rgb(33, 37, 41)');
    expect(el.style.textDecoration).toBe('none');
    expect(el.style.borderRadius).toBe('2px');
    expect(el.style.cursor).toBe('pointer');
    expect(el.style.display).toBe('inline');
    expect(el.style.whiteSpace).toBe('pre-wrap');
    expect(el.style.wordBreak).toBe('break-word');
    expect(el.style.maxWidth).toBe('100%');
    // Verify active state uses ring for outline (not 'none')
    expect(el.style.outline).not.toBe('none');
  });

  it('sets expected inline styles for active=false', () => {
    const el = document.createElement('span');
    applyMermaidHighlightStyles(el, theme, false);

    expect(el.style.backgroundColor).toBe('rgb(255, 243, 205)'); // background
    expect(el.style.outline).toBe('none');
  });

  it('sets box-decoration-break and webkit prefix', () => {
    const el = document.createElement('span');
    applyMermaidHighlightStyles(el, theme, false);

    expect(el.style.boxDecorationBreak).toBe('clone');
  });
});

describe('applyMermaidSvgTextHighlight', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const theme = {
    background: '#fff3cd',
    activeBackground: '#ffeaa7',
    color: '#212529',
    underline: '#f0ad4e',
    activeUnderline: '#e08e0b',
    ring: '#fd7e14',
  };

  // jsdom doesn't implement SVG layout APIs, so we stub the minimum surface
  // our helper depends on: getBBox, getNumberOfChars, getExtentOfChar.
  function makeSvgText(content: string): SVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const textEl = document.createElementNS(SVG_NS, 'text') as SVGElement;
    const tn = document.createTextNode(content);
    textEl.appendChild(tn);
    svg.appendChild(textEl);
    document.body.appendChild(svg);

    // Pretend each char is 10 wide, line is 20 tall, positioned at (0, 0).
    const charWidth = 10;
    const lineHeight = 20;
    const stub = textEl as unknown as SVGTextContentElement & SVGGraphicsElement;
    stub.getBBox = () =>
      ({
        x: 0,
        y: 0,
        width: content.length * charWidth,
        height: lineHeight,
      }) as DOMRect;
    stub.getNumberOfChars = () => content.length;
    stub.getExtentOfChar = (i: number) =>
      ({
        x: i * charWidth,
        y: 0,
        width: charWidth,
        height: lineHeight,
      }) as DOMRect;

    return textEl;
  }

  it('inserts a soft background rect + an underline rect for the matched range', () => {
    const textEl = makeSvgText('POST /auth/login');
    const authStart = 6;
    const authEnd = 10;

    applyMermaidSvgTextHighlight(textEl, theme, false, authStart, authEnd);

    const rects = textEl.parentNode!.querySelectorAll('rect.mermaid-svg-text-highlight-bg');
    expect(rects.length).toBe(2);
    // First rect = soft background tint, sized to the matched range with padding.
    const bg = rects[0];
    expect(Number(bg.getAttribute('x'))).toBe(57);
    expect(Number(bg.getAttribute('width'))).toBe(46);
    // Color is applied via inline style (which beats Mermaid's CSS).
    expect(bg.getAttribute('style')).toContain('fill: #f0ad4e');
    expect(bg.getAttribute('style')).toContain('fill-opacity: 0.12');
    expect(bg.getAttribute('style')).toContain('stroke: none');
    // Second rect = thin underline at the baseline.
    const underline = rects[1];
    expect(underline.getAttribute('style')).toContain('fill: #f0ad4e');
    expect(underline.getAttribute('style')).toContain('fill-opacity: 1');
    expect(Number(underline.getAttribute('height'))).toBeLessThan(5);
  });

  it('uses the active accent + slightly thicker underline for active state', () => {
    const textEl = makeSvgText('POST /auth/login');
    applyMermaidSvgTextHighlight(textEl, theme, true, 6, 10);

    const rects = textEl.parentNode!.querySelectorAll('rect.mermaid-svg-text-highlight-bg');
    expect(rects.length).toBe(2);
    const bg = rects[0];
    expect(bg.getAttribute('style')).toContain('fill: #e08e0b'); // activeUnderline
    expect(bg.getAttribute('style')).toContain('fill-opacity: 0.2');
    const underline = rects[1];
    expect(underline.getAttribute('style')).toContain('fill: #e08e0b');
    expect(Number(underline.getAttribute('height'))).toBeGreaterThan(2);
  });

  it('does not set whole-element text styles that would conflict with the substring rect', () => {
    // Styles that can only apply to the whole <text> (text-decoration,
    // font-weight, fill) would contradict the per-character highlight rect
    // when the anchor is a substring. Only cursor: pointer is set on the
    // element itself.
    const textEl = makeSvgText('POST /auth/login');
    applyMermaidSvgTextHighlight(textEl, theme, true, 6, 10);

    expect(textEl.style.cursor).toBe('pointer');
    expect(textEl.style.textDecoration).toBe('');
    expect(textEl.style.fontWeight).toBe('');
  });

  it('falls back to full element bbox when no range is supplied', () => {
    const textEl = makeSvgText('Authenticated');
    applyMermaidSvgTextHighlight(textEl, theme, false);

    const rect = textEl.parentNode?.querySelector('rect.mermaid-svg-text-highlight-bg');
    expect(rect).not.toBeNull();
    // Full width: 13 chars * 10 = 130, padded by 3 each side → x=-3, width=136
    expect(Number(rect!.getAttribute('x'))).toBe(-3);
    expect(Number(rect!.getAttribute('width'))).toBe(136);
  });

  it('replaces stale highlight rects on re-application', () => {
    const textEl = makeSvgText('POST /auth/login');
    applyMermaidSvgTextHighlight(textEl, theme, false, 6, 10);
    applyMermaidSvgTextHighlight(textEl, theme, true, 6, 10);

    const rects = textEl.parentNode!.querySelectorAll('rect.mermaid-svg-text-highlight-bg');
    // Two rects per highlight (bg + underline), one highlight at a time.
    expect(rects.length).toBe(2);
    expect(rects[0].getAttribute('style')).toContain('fill-opacity: 0.2');
  });

  it('keeps independent rects when distinct highlightKeys are used on the same element', () => {
    // Simulates the fullscreen modal drawing two different comments anchored
    // to non-overlapping substrings of the same `<text>` element ("POST" and
    // "/auth/login" inside "POST /auth/login"). Without per-comment keys, the
    // second call would clear the first's rects.
    const textEl = makeSvgText('POST /auth/login');
    applyMermaidSvgTextHighlight(textEl, theme, false, 0, 4, 'comment-a');
    applyMermaidSvgTextHighlight(textEl, theme, true, 5, 16, 'comment-b');

    const rects = textEl.parentNode!.querySelectorAll('rect.mermaid-svg-text-highlight-bg');
    // Two rects per highlight (bg + underline) × two highlights = 4 rects total.
    expect(rects.length).toBe(4);
    // Re-applying the first comment's highlight should only replace its own
    // rects, leaving the second comment's rects intact.
    applyMermaidSvgTextHighlight(textEl, theme, true, 0, 4, 'comment-a');
    const after = textEl.parentNode!.querySelectorAll('rect.mermaid-svg-text-highlight-bg');
    expect(after.length).toBe(4);
  });
});
