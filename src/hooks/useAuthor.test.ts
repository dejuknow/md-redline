import { describe, it, expect } from 'vitest';
import { hashString, getAuthorColor } from './useAuthor';

describe('hashString', () => {
  it('returns a non-negative number', () => {
    expect(hashString('test')).toBeGreaterThanOrEqual(0);
    expect(hashString('another string')).toBeGreaterThanOrEqual(0);
  });

  it('returns the same hash for the same input', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('returns different hashes for different inputs', () => {
    expect(hashString('alice')).not.toBe(hashString('bob'));
  });

  it('returns 0 for empty string', () => {
    expect(hashString('')).toBe(0);
  });

  it('handles single character', () => {
    expect(hashString('a')).toBeGreaterThanOrEqual(0);
  });
});

describe('getAuthorColor', () => {
  it('returns a color object with bg, text, border', () => {
    const color = getAuthorColor('Alice');
    expect(color).toHaveProperty('bg');
    expect(color).toHaveProperty('text');
    expect(color).toHaveProperty('border');
    expect(color.bg).toMatch(/^#/);
    expect(color.text).toMatch(/^#/);
    expect(color.border).toMatch(/^#/);
  });

  it('returns the same color for the same author', () => {
    expect(getAuthorColor('Alice')).toEqual(getAuthorColor('Alice'));
  });

  it('returns different colors for different authors', () => {
    // Not guaranteed for all pairs, but very likely for these
    const colors = new Set([
      getAuthorColor('Alice').bg,
      getAuthorColor('Bob').bg,
      getAuthorColor('Charlie').bg,
    ]);
    expect(colors.size).toBeGreaterThan(1);
  });

  it('returns a valid color for empty string', () => {
    const color = getAuthorColor('');
    expect(color).toHaveProperty('bg');
    expect(color).toHaveProperty('text');
    expect(color).toHaveProperty('border');
  });
});
