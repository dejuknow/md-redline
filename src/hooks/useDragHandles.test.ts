// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { isSvgTextMark } from './useDragHandles';

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('isSvgTextMark', () => {
  it('returns true for an SVG <text> element', () => {
    const el = document.createElementNS(SVG_NS, 'text');
    expect(isSvgTextMark(el)).toBe(true);
  });

  it('returns false for an HTML element', () => {
    const el = document.createElement('mark');
    expect(isSvgTextMark(el)).toBe(false);
  });

  it('returns false for SVG elements that are not <text>', () => {
    expect(isSvgTextMark(document.createElementNS(SVG_NS, 'rect'))).toBe(false);
    expect(isSvgTextMark(document.createElementNS(SVG_NS, 'g'))).toBe(false);
    expect(isSvgTextMark(document.createElementNS(SVG_NS, 'tspan'))).toBe(false);
  });

  it('returns false for an HTML <text> (should not exist, but guards namespace check)', () => {
    // createElement creates an HTML unknown element, not an SVG one
    const el = document.createElement('text');
    expect(isSvgTextMark(el)).toBe(false);
  });
});
