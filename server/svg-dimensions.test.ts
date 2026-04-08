import { describe, it, expect } from 'vitest';
import { injectSvgDimensions } from './svg-dimensions';

function asString(buf: Buffer<ArrayBuffer>): string {
  return buf.toString('utf-8');
}

function svg(content: string): Buffer<ArrayBuffer> {
  return Buffer.from(content, 'utf-8');
}

describe('injectSvgDimensions', () => {
  it('injects width and height when only viewBox is set', () => {
    const input = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 116"><rect/></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="100"');
    expect(result).toContain('height="116"');
    expect(result).toContain('viewBox="0 0 100 116"');
  });

  it('injects dimensions before existing attributes', () => {
    const input = svg('<svg viewBox="0 0 50 25"></svg>');
    const result = asString(injectSvgDimensions(input));
    // The new attributes go right after `<svg`
    expect(result).toMatch(/^<svg width="50" height="25" viewBox/);
  });

  it('handles viewBox with comma separators', () => {
    const input = svg('<svg viewBox="0,0,200,300"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="200"');
    expect(result).toContain('height="300"');
  });

  it('handles viewBox with mixed comma and whitespace separators', () => {
    const input = svg('<svg viewBox="0, 0, 80, 40"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="80"');
    expect(result).toContain('height="40"');
  });

  it('handles viewBox with decimal values', () => {
    const input = svg('<svg viewBox="0 0 100.5 50.25"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="100.5"');
    expect(result).toContain('height="50.25"');
  });

  it('handles viewBox with negative origin', () => {
    const input = svg('<svg viewBox="-10 -20 100 200"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="100"');
    expect(result).toContain('height="200"');
  });

  it('handles a multi-line svg opening tag', () => {
    const input = svg(`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
    ><circle/></svg>`);
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="32"');
    expect(result).toContain('height="32"');
  });

  it('leaves the svg unchanged when width is already set', () => {
    const input = svg('<svg width="50" viewBox="0 0 100 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when height is already set', () => {
    const input = svg('<svg height="50" viewBox="0 0 100 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when both width and height are set', () => {
    const input = svg('<svg width="50" height="50" viewBox="0 0 100 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when there is no viewBox', () => {
    const input = svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when viewBox has the wrong number of values', () => {
    const input = svg('<svg viewBox="0 0 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when viewBox values are non-numeric', () => {
    const input = svg('<svg viewBox="0 0 abc def"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when viewBox width is zero', () => {
    const input = svg('<svg viewBox="0 0 0 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves the svg unchanged when viewBox values have units like 100px', () => {
    // viewBox values are unitless per spec; "100px" is invalid
    const input = svg('<svg viewBox="0 0 100px 100px"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves a non-svg buffer unchanged', () => {
    const input = svg('<html><body>not an svg</body></html>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('returns the same Buffer instance when no change is needed', () => {
    const input = svg('<svg width="50" height="50"></svg>');
    const result = injectSvgDimensions(input);
    // Same instance — no allocation when no change needed
    expect(result).toBe(input);
  });

  it('preserves an XML declaration before the svg tag', () => {
    const input = svg('<?xml version="1.0"?><svg viewBox="0 0 10 20"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('<?xml version="1.0"?>');
    expect(result).toContain('width="10"');
    expect(result).toContain('height="20"');
  });

  it('only modifies the first svg tag if there are nested svgs', () => {
    const input = svg(
      '<svg viewBox="0 0 100 100"><svg viewBox="0 0 50 50"></svg></svg>',
    );
    const result = asString(injectSvgDimensions(input));
    // Outer svg gets injected dimensions (100, 100), inner is left alone
    expect(result).toMatch(/<svg width="100" height="100" viewBox="0 0 100 100"/);
    // The inner svg should NOT get injected dimensions — its tag is not the first match
    // Verify by counting how many `width="` attributes appear
    const widthCount = (result.match(/width="/g) ?? []).length;
    expect(widthCount).toBe(1);
  });

  it('leaves a namespaced svg root tag unchanged', () => {
    // <svg:svg> is rare but valid; we don't try to handle it because
    // injecting attributes mid-tag would corrupt the element name.
    const input = svg(
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg:svg>',
    );
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves an svg with negative viewBox width unchanged', () => {
    const input = svg('<svg viewBox="0 0 -100 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('leaves an svg with negative viewBox height unchanged', () => {
    const input = svg('<svg viewBox="0 0 100 -50"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('handles a viewBox with a trailing comma separator', () => {
    // Filtered empty parts should let "0 0 100 100," still parse
    const input = svg('<svg viewBox="0 0 100 100,"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="100"');
    expect(result).toContain('height="100"');
  });

  it('handles a viewBox with a leading comma separator', () => {
    const input = svg('<svg viewBox=",0 0 100 100"></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="100"');
    expect(result).toContain('height="100"');
  });

  it('handles an svg with a DOCTYPE preamble', () => {
    const input = svg(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg viewBox="0 0 32 32"><rect/></svg>',
    );
    const result = asString(injectSvgDimensions(input));
    // DOCTYPE preserved, dimensions injected on the actual root svg
    expect(result).toContain('<!DOCTYPE svg PUBLIC');
    expect(result).toContain('<svg width="32" height="32" viewBox="0 0 32 32"');
  });

  it('handles leading whitespace before the svg tag', () => {
    const input = svg('  \n  <svg viewBox="0 0 64 64"><rect/></svg>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toContain('width="64"');
    expect(result).toContain('height="64"');
  });

  it('handles a self-closing svg tag', () => {
    // Edge case: an empty svg with no children. Self-closing form `<svg/>`
    // is valid. Our regex matches `<svg(?=[\s/>])` so the `/` lookahead
    // succeeds, the captured attrs is empty, no viewBox, no injection.
    const input = svg('<svg/>');
    const result = asString(injectSvgDimensions(input));
    expect(result).toBe(input.toString('utf-8'));
  });

  it('handles a self-closing svg tag with viewBox', () => {
    const input = svg('<svg viewBox="0 0 16 16"/>');
    const result = asString(injectSvgDimensions(input));
    // The capture `[^>]*` includes `/`, but the regex still matches up to `>`.
    // The injection point is right after `<svg`, so the `/` stays in place.
    expect(result).toContain('width="16"');
    expect(result).toContain('height="16"');
    // The self-closing form is preserved
    expect(result).toMatch(/\/>$/);
  });
});
