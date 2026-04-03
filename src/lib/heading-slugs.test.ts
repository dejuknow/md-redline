import { describe, it, expect } from 'vitest';
import { slugify, uniqueSlugs } from './heading-slugs';

describe('slugify', () => {
  it('converts text to lowercase hyphenated slug', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips special characters', () => {
    expect(slugify("What's New?")).toBe('whats-new');
  });

  it('collapses multiple spaces to single hyphen', () => {
    expect(slugify('Hello   World')).toBe('hello-world');
  });

  it('trims whitespace', () => {
    expect(slugify('  Hello  ')).toBe('hello');
  });

  it('preserves hyphens', () => {
    expect(slugify('pre-existing')).toBe('pre-existing');
  });

  it('preserves underscores', () => {
    expect(slugify('my_variable')).toBe('my_variable');
  });

  it('handles numbers', () => {
    expect(slugify('Section 1.2')).toBe('section-12');
  });

  it('falls back to "heading" for empty text', () => {
    expect(slugify('')).toBe('heading');
    expect(slugify('   ')).toBe('heading');
  });

  it('falls back to "heading" when all chars are stripped', () => {
    expect(slugify('!@#$%')).toBe('heading');
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(slugify('Hello\tWorld\nFoo')).toBe('hello-world-foo');
  });
});

describe('uniqueSlugs', () => {
  it('returns unique slugs for distinct headings', () => {
    expect(uniqueSlugs(['Introduction', 'Background', 'Conclusion'])).toEqual([
      'introduction',
      'background',
      'conclusion',
    ]);
  });

  it('appends -1, -2 for duplicate headings', () => {
    expect(uniqueSlugs(['Overview', 'Overview', 'Overview'])).toEqual([
      'overview',
      'overview-1',
      'overview-2',
    ]);
  });

  it('handles mixed duplicates', () => {
    expect(uniqueSlugs(['Title', 'Sub', 'Detail', 'Sub'])).toEqual([
      'title',
      'sub',
      'detail',
      'sub-1',
    ]);
  });

  it('handles empty heading text', () => {
    expect(uniqueSlugs(['', ''])).toEqual(['heading', 'heading-1']);
  });

  it('handles headings that become identical after slugification', () => {
    // "Hello World!" and "Hello World?" both slugify to "hello-world"
    expect(uniqueSlugs(['Hello World!', 'Hello World?'])).toEqual(['hello-world', 'hello-world-1']);
  });

  it('returns empty array for no headings', () => {
    expect(uniqueSlugs([])).toEqual([]);
  });
});
